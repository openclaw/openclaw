// Ensure Extension Memory Build tests cover ensure extension memory build script behavior.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureExtensionMemoryBuild,
  hasBuiltExtensionMemoryEntries,
} from "../../scripts/ensure-extension-memory-build.mts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-build-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-all.mts"), "", "utf8");
  return root;
}

function writeFixture(root: string, relativePath: string, body = "export {};\n") {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensure-extension-memory-build", () => {
  it.each(["extensions/external/dist/index.js"])(
    "reuses selected built entry %s without building unrelated plugins",
    (entry) => {
      const root = makeTempRoot();
      writeFixture(root, entry);
      writeFixture(root, "extensions/internal/openclaw.plugin.json", '{"id":"internal"}');
      writeFixture(root, "extensions/internal/index.ts");
      writeFixture(root, "extensions/external/index.ts", 'throw new Error("source imported");');

      const result = ensureExtensionMemoryBuild({
        rootDir: root,
        requiredExtensionIds: ["external"],
        spawnSync: () => {
          throw new Error("unexpected build");
        },
      });

      expect(result).toEqual({ built: false });
    },
  );

  it.each([["dist/extensions/external/index.js", ["external", "internal"]]])(
    "builds when %s does not satisfy required ids %j",
    (entry, requiredExtensionIds) => {
      const root = makeTempRoot();
      writeFixture(root, entry);
      const params = { rootDir: root, requiredExtensionIds };
      expect(ensureExtensionMemoryBuild({ ...params, spawnSync: () => ({ status: 0 }) })).toEqual({
        built: true,
      });
    },
  );

  it("requires all expected bundled entries by default even when local output exists", () => {
    const root = makeTempRoot();
    for (const id of ["internal-a", "internal-b", "external"]) {
      writeFixture(root, `extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
      writeFixture(root, `extensions/${id}/index.ts`);
    }
    writeFixture(
      root,
      "extensions/external/package.json",
      JSON.stringify({ openclaw: { build: { bundledDist: false } } }),
    );
    writeFixture(root, "extensions/external/dist/index.js");
    writeFixture(root, "dist/extensions/internal-a/index.js");
    expect(hasBuiltExtensionMemoryEntries({ rootDir: root, env: {} })).toBe(false);
    writeFixture(root, "dist/extensions/internal-b/index.js");
    expect(hasBuiltExtensionMemoryEntries({ rootDir: root, env: {} })).toBe(true);
  });

  it("fails when the cliStartup build profile fails", () => {
    const root = makeTempRoot();

    expect(() =>
      ensureExtensionMemoryBuild({
        rootDir: root,
        spawnSync: () => ({ status: 1 }),
        stdio: "pipe",
      }),
    ).toThrow("cliStartup build profile failed with exit code 1");
  });
});
