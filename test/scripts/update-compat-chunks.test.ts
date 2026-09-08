import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
  type UpdateCompatibilityInventory,
  type UpdateCompatibilityRelease,
} from "../../scripts/lib/update-compat-chunks.mts";
import { writeStableRootRuntimeAliases } from "../../scripts/runtime-postbuild.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function recordFixture(): UpdateCompatibilityInventory & {
  releases: [UpdateCompatibilityRelease];
} {
  const root = createTempDir("update-compat-release-");
  write(root, "package.json", JSON.stringify({ name: "openclaw", version: "2026.9.1" }));
  write(
    root,
    "dist/build-info.json",
    JSON.stringify({ version: "2026.9.1", buildId: "fixture", commit: "0".repeat(40) }),
  );
  write(
    root,
    "dist/command.js",
    [
      "//#region src/cli/update-cli/update-command-service-command.ts",
      'export async function restart() { return (await import("./service-abcdefgh.js")).runner(); }',
      'export async function recover() { const { mode: selected } = await import("./service-abcdefgh.js"); return selected(); }',
    ].join("\n"),
  );
  write(
    root,
    "dist/service-abcdefgh.js",
    'export { r as runner, m as mode } from "./implementation-12345678.js";',
  );
  write(
    root,
    "dist/implementation-12345678.js",
    [
      "//#region src/cli/update-cli/runner.ts",
      'function resolveRunner() { return "old"; }',
      "//#region src/cli/update-cli/recovery.ts",
      'function resolveMode() { return "old"; }',
      "export { resolveRunner as r, resolveMode as m };",
    ].join("\n"),
  );
  return {
    schemaVersion: 1,
    releases: [recordUpdateCompatibilityRelease({ packageDir: root, integrity })],
  };
}

function candidate(root: string): void {
  write(root, "src/cli/update-cli/recovery.ts", 'import { resolveMode } from "./mode.js";');
  write(root, "src/cli/update-cli/mode.ts", 'export function resolveMode() { return "npm"; }');
  write(
    root,
    "dist/current.mjs",
    [
      "//#region src/cli/update-cli/runner.ts",
      'function resolveRunner() { return "node"; }',
      "//#region src/cli/update-cli/mode.ts",
      'function resolveMode() { return "npm"; }',
      "export { resolveRunner as x, resolveMode as y };",
    ].join("\n"),
  );
}

describe("previous release update compatibility", () => {
  it("keeps compatibility facades out of current runtime alias selection on rebuild", async () => {
    const inventory = recordFixture();
    inventory.releases[0].chunks = inventory.releases[0].chunks.map((chunk) => ({
      ...chunk,
      path: "worker.runtime-12345678.js",
    }));
    const root = createTempDir("update-compat-rebuild-");
    candidate(root);
    fs.renameSync(
      path.join(root, "dist/current.mjs"),
      path.join(root, "dist/worker.runtime-abcdefgh.mjs"),
    );
    writeStableRootRuntimeAliases({ rootDir: root });
    writeUpdateCompatibilityChunks({
      distDir: path.join(root, "dist"),
      sourceDir: root,
      inventory,
    });
    writeStableRootRuntimeAliases({ rootDir: root });
    const current = await import(pathToFileURL(path.join(root, "dist/worker.runtime.js")).href);
    expect(current.x()).toBe("node");
    expect(current.y()).toBe("npm");
  });

  it("records emitted aliases and forwards old consumers to the current implementations", async () => {
    const inventory = recordFixture();
    expect(inventory.releases[0].chunks).toMatchObject([
      {
        path: "service-abcdefgh.js",
        exports: [
          {
            exported: "mode",
            origin: { module: "src/cli/update-cli/recovery.ts", symbol: "resolveMode" },
          },
          {
            exported: "runner",
            origin: { module: "src/cli/update-cli/runner.ts", symbol: "resolveRunner" },
          },
        ],
      },
    ]);
    const root = createTempDir("update-compat-candidate-");
    candidate(root);
    const options = { distDir: path.join(root, "dist"), sourceDir: root, inventory };
    writeUpdateCompatibilityChunks(options);
    const bridge = path.join(root, "dist/service-abcdefgh.js");
    const first = fs.readFileSync(bridge, "utf8");
    writeUpdateCompatibilityChunks(options);
    expect(fs.readFileSync(bridge, "utf8")).toBe(first);
    const loaded = await import(pathToFileURL(bridge).href);
    expect(loaded.runner()).toBe("node");
    expect(loaded.mode()).toBe("npm");
  });

  it.each(["missing", "ambiguous"])(
    "refuses %s required implementations before writing bridges",
    (failure) => {
      const inventory = recordFixture();
      const root = createTempDir("update-compat-refusal-");
      candidate(root);
      if (failure === "missing") {
        write(root, "dist/current.mjs", "export {};\n");
      } else {
        fs.copyFileSync(path.join(root, "dist/current.mjs"), path.join(root, "dist/duplicate.mjs"));
      }
      expect(() =>
        writeUpdateCompatibilityChunks({
          distDir: path.join(root, "dist"),
          sourceDir: root,
          inventory,
        }),
      ).toThrow(/Cannot bridge service-abcdefgh\.js export mode/);
      expect(fs.existsSync(path.join(root, "dist/service-abcdefgh.js"))).toBe(false);
    },
  );

  it("does not replace a public entrypoint to conceal a missing export", () => {
    const inventory = recordFixture();
    inventory.releases[0].chunks = inventory.releases[0].chunks.map((chunk) => ({
      ...chunk,
      path: "service.js",
    }));
    const root = createTempDir("update-compat-public-");
    candidate(root);
    const original = "export const other = true;\n";
    write(root, "dist/service.js", original);
    expect(() =>
      writeUpdateCompatibilityChunks({
        distDir: path.join(root, "dist"),
        sourceDir: root,
        inventory,
      }),
    ).toThrow(/service\.js lacks mode/);
    expect(fs.readFileSync(path.join(root, "dist/service.js"), "utf8")).toBe(original);
  });
});
