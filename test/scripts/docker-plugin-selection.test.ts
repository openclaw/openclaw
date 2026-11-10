import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveDockerPluginSelection } from "../../scripts/lib/docker-plugin-selection.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const selectorScript = path.join(repoRoot, "scripts/lib/docker-plugin-selection.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureRoot: string;
let extensionsRoot: string;
beforeEach(() => {
  fixtureRoot = tempDirs.make("openclaw-docker-plugin-selection-");
  extensionsRoot = path.join(fixtureRoot, "extensions");
  fs.mkdirSync(extensionsRoot);
});
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

function writePlugin(
  dirName: string,
  manifest?: { id: string; providers?: string[] },
  pkg: {
    dependencies?: Record<string, string>;
    openclaw?: { install: { requiredPlatformPackages: string[] } };
  } = {},
) {
  const pluginDir = path.join(extensionsRoot, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJson(path.join(pluginDir, "package.json"), { name: dirName, ...pkg });
  if (manifest) {
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), manifest);
  }
}

function runSelector(selection: string, ...flags: string[]) {
  return spawnSync(process.execPath, [selectorScript, extensionsRoot, selection, ...flags], {
    encoding: "utf8",
  });
}

function expectOutput(output: string, ...args: Parameters<typeof runSelector>) {
  expect(runSelector(...args)).toMatchObject({ status: 0, stdout: output, stderr: "" });
}

it("adds standalone direct and Gateway provider selections to the shared live image", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/print-live-docker-plugin-selection.mjs"), repoRoot, "twitch"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        OPENCLAW_LIVE_PROVIDERS: "ollama",
        OPENCLAW_LIVE_GATEWAY_MODELS: "mistral/mistral-large-latest",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split(",")).toEqual(
    expect.arrayContaining(["ollama", "mistral", "twitch"]),
  );
});

it("selects provider owners by manifest capability without assuming matching plugin ids", () => {
  writePlugin("provider-source", {
    id: "provider-plugin",
    providers: ["api-provider", "portal-provider"],
  });
  writePlugin("other-source", { id: "other-plugin" });

  expect(
    resolveDockerPluginSelection({
      extensionsRoot,
      selection: "other-plugin,provider-plugin",
      providers: ["portal-provider", "custom-unregistered-provider"],
    }),
  ).toEqual(["other-source", "provider-source"]);
  expect(resolveDockerPluginSelection({ extensionsRoot, providers: ["api-provider"] })).toEqual([
    "provider-source",
  ]);
});

it("includes required core-bundled dependencies without changing optional plugin selections", () => {
  const rootPackagePath = path.join(fixtureRoot, "package.json");
  writeJson(rootPackagePath, { files: ["dist/", "!dist/extensions/optional-provider/**"] });
  writePlugin("bundled-provider", { id: "bundled" }, { dependencies: { sdk: "1" } });
  writePlugin("bundled-without-deps", { id: "without-deps" });
  writePlugin(
    "optional-provider",
    { id: "optional" },
    {
      dependencies: { sdk: "1" },
      openclaw: { install: { requiredPlatformPackages: ["linux", "darwin", "linux"] } },
    },
  );

  expectOutput("bundled-provider\n", "", "--required-bundled", rootPackagePath);
  expectOutput(
    "bundled-provider\noptional-provider\n",
    "optional",
    "--required-bundled",
    rootPackagePath,
  );
  expectOutput("optional-provider\n", "optional");
  expectOutput("darwin\nlinux\n", "optional", "--required-platform-packages");
  expect(runSelector("", "--required-platform-packages").stdout).toBe("");
});

it("resolves manifest ids and source directory names deterministically", () => {
  writePlugin("source-only");
  writePlugin("provider-source", { id: "provider-id" });
  expectOutput(
    "provider-source\nsource-only\n",
    "source-only,provider-id provider-source,provider-id",
  );
});

it("fails closed for unknown, invalid, and ambiguous ids", () => {
  writePlugin("shared");
  writePlugin("other-source", { id: "shared" });

  for (const [selection, message] of [
    ["missing-plugin", "unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin"],
    ["../invalid", "invalid OPENCLAW_EXTENSIONS plugin id: ../invalid"],
    ["shared", "ambiguous OPENCLAW_EXTENSIONS plugin id: shared"],
  ] as const) {
    expect(runSelector(selection)).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringContaining(message),
    });
  }
});
