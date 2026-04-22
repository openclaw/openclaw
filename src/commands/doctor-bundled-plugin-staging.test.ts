import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import {
  createBundledPluginStagingInstallEnv,
  discoverMissingBundledPluginStaging,
  repairBundledPluginStaging,
  summarizeRepairForUpdateStep,
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
  packageJsonBody?: string;
};

function writeExtension(params: WriteExtensionParams): void {
  const extDir = path.join(params.extensionsDir, params.id);
  fs.mkdirSync(extDir, { recursive: true });
  const body =
    params.packageJsonBody ??
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
    );
  fs.writeFileSync(path.join(extDir, "package.json"), body);
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

  it("skips a package.json larger than 1MB without blocking other entries", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });
    // Craft an oversize package.json: 1.5MB of padding inside a large string field.
    const padding = "x".repeat(1_500_000);
    const oversize = JSON.stringify({
      name: "@openclaw/giant",
      version: "2026.4.21",
      description: padding,
      dependencies: { "example-dep": "^1.0.0" },
      openclaw: { bundle: { stageRuntimeDependencies: true } },
    });
    writeExtension({
      extensionsDir,
      id: "giant",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
      packageJsonBody: oversize,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
    expect(result.checked.map((entry) => entry.id)).toEqual(["slack"]);
  });
});

describe("repairBundledPluginStaging", () => {
  it("passes --ignore-scripts to pnpm and runs per missing plugin dir", async () => {
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
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0].command).toBe("pnpm");
    expect(invocations[0].args).toEqual(["install", "--prod", "--ignore-scripts"]);
    expect(invocations.map((i) => path.basename(i.cwd)).toSorted()).toEqual(["codex", "google"]);
    expect(result.repaired.map((entry) => entry.id).toSorted()).toEqual(["codex", "google"]);
    expect(result.failed).toEqual([]);
  });

  it("passes --ignore-scripts to npm (via install --omit=dev)", async () => {
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
    expect(invocations[0].args).toEqual(["install", "--omit=dev", "--ignore-scripts"]);
  });

  it("spawns a caller-resolved executable path when packageManagerCommand is provided", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const invocations: Array<{ command: string; args: string[] }> = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "npm",
      packageManagerCommand: "/opt/homebrew/bin/npm",
      runCommand: async ({ command, args, cwd }) => {
        invocations.push({ command, args });
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations[0].command).toBe("/opt/homebrew/bin/npm");
    // Args are still manager-specific (npm omits dev via --omit=dev).
    expect(invocations[0].args).toContain("--omit=dev");
  });

  it("passes lockfile-disabling env vars to the install subprocess", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const received: Array<NodeJS.ProcessEnv | undefined> = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      runCommand: async ({ cwd, env }) => {
        received.push(env);
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(received).toHaveLength(1);
    const env = received[0];
    expect(env?.npm_config_package_lock).toBe("false");
    expect(env?.npm_config_save).toBe("false");
    expect(env?.npm_config_legacy_peer_deps).toBe("true");
  });

  it("composes baseEnv under the staging env overlays so caller-provided PATH/corepack settings flow through", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const received: Array<NodeJS.ProcessEnv | undefined> = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      baseEnv: {
        PATH: "/trusted/bin:/usr/bin",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        npm_config_global: "true",
      },
      runCommand: async ({ cwd, env }) => {
        received.push(env);
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const env = received[0];
    // Base env PATH / corepack settings survive.
    expect(env?.PATH).toBe("/trusted/bin:/usr/bin");
    expect(env?.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    // Nested-install leakage still gets stripped from the base env.
    expect(env?.npm_config_global).toBeUndefined();
    // Staging-specific overlays are applied on top.
    expect(env?.npm_config_package_lock).toBe("false");
  });

  it("uses a caller-provided missing list and skips its own discovery scan", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
      hasNodeModules: false,
    });

    const invocations: string[] = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      // Explicit list with only one entry; repair should not rescan and find the second.
      missing: [
        {
          id: "codex",
          expectedPath: path.join(extensionsDir, "codex", "node_modules"),
          dependencyCount: 1,
        },
      ],
      runCommand: async ({ cwd }) => {
        invocations.push(path.basename(cwd));
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations).toEqual(["codex"]);
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

describe("createBundledPluginStagingInstallEnv", () => {
  it("strips nested npm install context and sets deterministic install flags", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      npm_config_global: "true",
      npm_config_location: "global",
      npm_config_prefix: "/opt/homebrew",
    };

    const result = createBundledPluginStagingInstallEnv(sourceEnv);

    expect(result.PATH).toBe("/usr/bin");
    expect(result.npm_config_global).toBeUndefined();
    expect(result.npm_config_location).toBeUndefined();
    expect(result.npm_config_prefix).toBeUndefined();
    expect(result.npm_config_package_lock).toBe("false");
    expect(result.npm_config_save).toBe("false");
    expect(result.npm_config_legacy_peer_deps).toBe("true");
  });
});

describe("summarizeRepairForUpdateStep", () => {
  it("reports step OK with null stderrTail when every missing plugin was repaired", () => {
    const result = summarizeRepairForUpdateStep({
      attempted: 2,
      repair: {
        repaired: [{ id: "codex" }, { id: "google" }],
        failed: [],
      },
    });

    expect(result.stepExitCode).toBe(0);
    expect(result.stderrTail).toBeNull();
    expect(result.stdoutTail).toBe("staged 2 of 2: codex, google");
  });

  it("reports step OK with failed entries in stderrTail when repair was partial", () => {
    // Partial success: core binary is installed, some plugins couldn't be
    // staged. Failed plugins are no worse off than pre-update, so the update
    // as a whole should not flip to `status: "error"`.
    const result = summarizeRepairForUpdateStep({
      attempted: 3,
      repair: {
        repaired: [{ id: "codex" }],
        failed: [
          { id: "google", exitCode: 1, detail: "network timeout" },
          { id: "webhooks", exitCode: 1, detail: "ENOSPC" },
        ],
      },
    });

    expect(result.stepExitCode).toBe(0);
    expect(result.stdoutTail).toBe("staged 1 of 3: codex");
    expect(result.stderrTail).toBe("google: network timeout\nwebhooks: ENOSPC");
  });

  it("reports step error when work was attempted and zero plugins were repaired", () => {
    const result = summarizeRepairForUpdateStep({
      attempted: 2,
      repair: {
        repaired: [],
        failed: [
          { id: "codex", exitCode: 1, detail: "network timeout" },
          { id: "google", exitCode: 1, detail: "network timeout" },
        ],
      },
    });

    expect(result.stepExitCode).toBe(1);
    expect(result.stdoutTail).toBe("staged 0 of 2: (none)");
    expect(result.stderrTail).toBe("codex: network timeout\ngoogle: network timeout");
  });
});
