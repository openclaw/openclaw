import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import {
  discoverMissingBundledPluginStaging,
  repairBundledPluginStaging,
} from "./doctor-bundled-plugin-staging.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

type WriteExtensionParams = {
  extensionsDir: string;
  id: string;
  stageRuntimeDependencies: boolean;
  dependencies?: Record<string, string>;
  hasNodeModules?: boolean;
};

function writeExtension(params: WriteExtensionParams): void {
  const extDir = path.join(params.extensionsDir, params.id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "package.json"),
    JSON.stringify(
      {
        name: `@openclaw/${params.id}`,
        version: "2026.4.21",
        dependencies: params.dependencies ?? { "example-dep": "^1.0.0" },
        openclaw: {
          bundle: { stageRuntimeDependencies: params.stageRuntimeDependencies },
        },
      },
      null,
      2,
    ),
  );
  if (params.hasNodeModules) {
    fs.mkdirSync(path.join(extDir, "node_modules"), { recursive: true });
  }
}

describe("discoverMissingBundledPluginStaging", () => {
  it("reports extensions that declare stageRuntimeDependencies:true but have no node_modules", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });
    writeExtension({
      extensionsDir,
      id: "discord",
      stageRuntimeDependencies: true,
      hasNodeModules: true,
    });
    writeExtension({
      extensionsDir,
      id: "qa-channel",
      stageRuntimeDependencies: false,
      hasNodeModules: false,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
    // Extensions that don't declare stageRuntimeDependencies are not checked.
    expect(result.checked.map((entry) => entry.id).toSorted()).toEqual(["discord", "slack"]);
  });

  it("skips stage=true extensions that declare zero runtime dependencies", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "no-deps",
      stageRuntimeDependencies: true,
      dependencies: {},
      hasNodeModules: false,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing).toEqual([]);
    expect(result.checked.map((entry) => entry.id)).toEqual(["no-deps"]);
  });

  it("returns empty result when extensions dir does not exist", () => {
    const tempRoot = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    const missingDir = path.join(tempRoot, "does-not-exist");

    const result = discoverMissingBundledPluginStaging({ extensionsDir: missingDir });

    expect(result.missing).toEqual([]);
    expect(result.checked).toEqual([]);
  });

  it("tolerates malformed package.json in an extension directory", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });
    const brokenDir = path.join(extensionsDir, "broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "package.json"), "{ not json");

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
  });
});

describe("repairBundledPluginStaging", () => {
  it("invokes the installer with --production-style args in each missing extension directory", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });
    writeExtension({
      extensionsDir,
      id: "google",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const invocations: Array<{ command: string; args: string[]; cwd: string }> = [];
    const result = await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      runCommand: async ({ command, args, cwd }) => {
        invocations.push({ command, args, cwd });
        // Simulate a successful install by creating the expected node_modules dir.
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0].command).toBe("pnpm");
    expect(invocations[0].args).toContain("install");
    expect(invocations[0].args).toContain("--prod");
    expect(invocations.map((i) => path.basename(i.cwd)).toSorted()).toEqual(["codex", "google"]);
    expect(result.repaired.map((entry) => entry.id).toSorted()).toEqual(["codex", "google"]);
    expect(result.failed).toEqual([]);
  });

  it("uses npm install --omit=dev when package manager is npm", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const invocations: Array<{ command: string; args: string[] }> = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "npm",
      runCommand: async ({ command, args, cwd }) => {
        invocations.push({ command, args });
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations[0].command).toBe("npm");
    expect(invocations[0].args).toContain("install");
    expect(invocations[0].args).toContain("--omit=dev");
  });

  it("records a failed repair when the installer exits non-zero", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const result = await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "install error: offline",
      }),
    });

    expect(result.repaired).toEqual([]);
    expect(result.failed.map((entry) => entry.id)).toEqual(["codex"]);
    expect(result.failed[0].detail).toContain("offline");
  });
});
