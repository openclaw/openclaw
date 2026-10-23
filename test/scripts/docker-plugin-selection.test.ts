import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  manifestId?: string,
  dependencies?: Record<string, string>,
  requiredPlatformPackages?: string[],
  providers?: string[],
) {
  const pluginDir = path.join(extensionsRoot, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJson(path.join(pluginDir, "package.json"), {
    name: dirName,
    dependencies,
    openclaw: requiredPlatformPackages ? { install: { requiredPlatformPackages } } : undefined,
  });
  if (manifestId) {
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), { id: manifestId, providers });
  }
}

function runSelector(
  selection: string,
  rootPackagePath?: string,
  requiredPlatformPackages = false,
) {
  const args = [selectorScript, extensionsRoot, selection];
  if (rootPackagePath) {
    args.push("--required-bundled", rootPackagePath);
  } else if (requiredPlatformPackages) {
    args.push("--required-platform-packages");
  }
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
  });
}

function expectOutput(output: string, ...args: Parameters<typeof runSelector>) {
  const result = runSelector(...args);
  expect(result).toMatchObject({ status: 0, stdout: output });
  return result;
}

describe("Docker plugin selection", () => {
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
    writePlugin("provider-source", "provider-plugin", undefined, undefined, [
      "api-provider",
      "portal-provider",
    ]);
    writePlugin("other-source", "other-plugin");

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
    writePlugin("bundled-provider", "bundled", { "provider-sdk": "1.0.0" });
    writePlugin("bundled-without-deps", "without-deps");
    writePlugin("optional-provider", "optional", { "optional-sdk": "1.0.0" }, [
      "optional-native-linux-arm64",
      "optional-native-darwin-arm64",
      "optional-native-linux-arm64",
    ]);

    expect(expectOutput("bundled-provider\n", "", rootPackagePath).stderr).toBe("");
    expectOutput("bundled-provider\noptional-provider\n", "optional", rootPackagePath);
    expectOutput("optional-provider\n", "optional");
    expectOutput(
      "optional-native-darwin-arm64\noptional-native-linux-arm64\n",
      "optional",
      undefined,
      true,
    );
    expect(runSelector("", undefined, true).stdout).toBe("");
  });

  it("resolves manifest ids and source directory names deterministically", () => {
    writePlugin("source-only");
    writePlugin("provider-source", "provider-id");
    const result = expectOutput(
      "provider-source\nsource-only\n",
      "source-only,provider-id provider-source,provider-id",
    );
    expect(result.stderr).toBe("");
  });

  it("fails closed for unknown, invalid, and ambiguous ids", () => {
    writePlugin("shared");
    writePlugin("other-source", "shared");

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
});
