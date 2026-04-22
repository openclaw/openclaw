import fs from "node:fs";
import os from "node:os";
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
  optionalDependencies?: Record<string, string>;
  stagedSentinels?: string[];
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
        ...(params.optionalDependencies
          ? { optionalDependencies: params.optionalDependencies }
          : {}),
        openclaw: {
          bundle: { stageRuntimeDependencies: params.stageRuntimeDependencies },
        },
      },
      null,
      2,
    );
  fs.writeFileSync(path.join(extDir, "package.json"), body);
  if (params.stagedSentinels && params.stagedSentinels.length > 0) {
    for (const depName of params.stagedSentinels) {
      const segments = depName.split("/");
      const sentinelDir = path.join(extDir, "node_modules", ...segments);
      fs.mkdirSync(sentinelDir, { recursive: true });
      fs.writeFileSync(
        path.join(sentinelDir, "package.json"),
        JSON.stringify({ name: depName, version: "1.0.0" }),
      );
    }
  }
}

describe("discoverMissingBundledPluginStaging", () => {
  it("reports extensions that declare stageRuntimeDependencies:true but have no staged deps", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
      dependencies: { "@slack/web-api": "^7.0.0" },
    });
    writeExtension({
      extensionsDir,
      id: "discord",
      stageRuntimeDependencies: true,
      dependencies: { "discord.js": "^14.0.0" },
      stagedSentinels: ["discord.js"],
    });
    writeExtension({
      extensionsDir,
      id: "qa-channel",
      stageRuntimeDependencies: false,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
    expect(result.checked.map((entry) => entry.id).toSorted()).toEqual(["discord", "slack"]);
    expect(result.checked.find((entry) => entry.id === "discord")?.hasStagedDeps).toBe(true);
    expect(result.checked.find((entry) => entry.id === "slack")?.hasStagedDeps).toBe(false);
  });

  it("skips stage=true extensions that declare zero runtime dependencies", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "no-deps",
      stageRuntimeDependencies: true,
      dependencies: {},
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing).toEqual([]);
    expect(result.checked.map((entry) => entry.id)).toEqual(["no-deps"]);
  });

  it("counts optionalDependencies toward the declared runtime-dep set", () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "with-optional",
      stageRuntimeDependencies: true,
      dependencies: {},
      optionalDependencies: { "only-optional-dep": "^1.0.0" },
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    // Plugin with zero `dependencies` but non-zero `optionalDependencies`
    // is still eligible for staging.
    expect(result.missing.map((entry) => entry.id)).toEqual(["with-optional"]);
    expect(result.checked[0]?.dependencyCount).toBe(1);
  });

  it("treats a plugin with node_modules but no dep sentinels as not staged", () => {
    // Simulates a failed/partial install that left an empty `node_modules/`
    // behind: `existsSync(node_modules)` is true but the declared deps'
    // `package.json` sentinels are missing.
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "partial",
      stageRuntimeDependencies: true,
      dependencies: { "@slack/web-api": "^7.0.0" },
    });
    fs.mkdirSync(path.join(extensionsDir, "partial", "node_modules"), { recursive: true });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["partial"]);
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
    });
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
      packageJsonBody: oversize,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
    expect(result.checked.map((entry) => entry.id)).toEqual(["slack"]);
  });

  it("skips symlinked entries that point outside the extensions directory", () => {
    if (process.platform === "win32") {
      return; // Symlink creation on Windows needs admin; skip there.
    }
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    const outsideTarget = path.join(os.tmpdir(), `ocl-outside-${Date.now()}`);
    fs.mkdirSync(outsideTarget, { recursive: true });
    tempDirs.push(outsideTarget);
    // Make the outside target look like a real extension dir.
    fs.writeFileSync(
      path.join(outsideTarget, "package.json"),
      JSON.stringify({
        name: "@openclaw/attacker",
        dependencies: { evil: "^1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      }),
    );
    fs.symlinkSync(outsideTarget, path.join(extensionsDir, "attacker"), "dir");
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
    });

    const result = discoverMissingBundledPluginStaging({ extensionsDir });

    expect(result.missing.map((entry) => entry.id)).toEqual(["slack"]);
    expect(result.checked.map((entry) => entry.id)).not.toContain("attacker");
  });
});

describe("repairBundledPluginStaging", () => {
  it("passes --ignore-scripts to pnpm and runs per missing plugin dir", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
    });
    writeExtension({
      extensionsDir,
      id: "google",
      stageRuntimeDependencies: true,
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
    expect(result.skipped).toEqual([]);
  });

  it("passes --ignore-scripts to npm (via install --omit=dev)", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
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
    expect(invocations[0].args).toContain("--omit=dev");
  });

  it("passes deterministic npm_config_* env to the install subprocess including audit/fund off", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
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
    expect(env?.npm_config_audit).toBe("false");
    expect(env?.npm_config_fund).toBe("false");
  });

  it("composes baseEnv under the staging env overlays so caller-provided PATH/corepack settings flow through", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
    });

    const received: Array<NodeJS.ProcessEnv | undefined> = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      baseEnv: {
        PATH: "/trusted/bin:/usr/bin",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      },
      runCommand: async ({ cwd, env }) => {
        received.push(env);
        fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const env = received[0];
    expect(env?.PATH).toBe("/trusted/bin:/usr/bin");
    expect(env?.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    expect(env?.npm_config_package_lock).toBe("false");
  });

  it("uses a caller-provided missing list and skips its own discovery scan", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "slack",
      stageRuntimeDependencies: true,
    });
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
    });

    const invocations: string[] = [];
    await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
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

  it("skips caller-provided entries whose path escapes the extensions directory", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
    });
    const outsideDir = makeTrackedTempDir("doctor-outside", tempDirs);

    const invocations: string[] = [];
    const result = await repairBundledPluginStaging({
      extensionsDir,
      packageManager: "pnpm",
      missing: [
        {
          id: "attacker",
          // Path that resolves outside the extensionsDir — must be rejected.
          expectedPath: path.join(outsideDir, "node_modules"),
          dependencyCount: 1,
        },
      ],
      runCommand: async ({ cwd }) => {
        invocations.push(cwd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(invocations).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.skipped.map((entry) => entry.id)).toEqual(["attacker"]);
  });

  it("records a failed repair when the installer exits non-zero", async () => {
    const extensionsDir = makeTrackedTempDir("doctor-bundled-plugin-staging", tempDirs);
    writeExtension({
      extensionsDir,
      id: "codex",
      stageRuntimeDependencies: true,
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
  it("shadows nested npm install context even when baseEnv has those keys set", () => {
    // runCommandWithTimeout's resolveCommandEnv merges process.env under the
    // caller's env. A plain `delete` would be silently restored. Setting the
    // stripped keys to `undefined` shadows the inherited value so the merge's
    // undefined-filter drops them from the final subprocess env.
    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      npm_config_global: "true",
      npm_config_location: "global",
      npm_config_prefix: "/opt/homebrew",
      NPM_CONFIG_GLOBAL: "true",
    };

    const result = createBundledPluginStagingInstallEnv(sourceEnv);

    expect(result.PATH).toBe("/usr/bin");
    expect(result.npm_config_global).toBeUndefined();
    expect(result.npm_config_location).toBeUndefined();
    expect(result.npm_config_prefix).toBeUndefined();
    expect(result.NPM_CONFIG_GLOBAL).toBeUndefined();
    expect(result.npm_config_package_lock).toBe("false");
    expect(result.npm_config_save).toBe("false");
    expect(result.npm_config_legacy_peer_deps).toBe("true");
    expect(result.npm_config_audit).toBe("false");
    expect(result.npm_config_fund).toBe("false");
  });
});

describe("summarizeRepairForUpdateStep", () => {
  it("reports step OK with null stderrTail when every missing plugin was repaired", () => {
    const result = summarizeRepairForUpdateStep({
      attempted: 2,
      repair: {
        repaired: [{ id: "codex" }, { id: "google" }],
        failed: [],
        skipped: [],
      },
    });

    expect(result.stepExitCode).toBe(0);
    expect(result.stderrTail).toBeNull();
    expect(result.stdoutTail).toBe("staged 2 of 2: codex, google");
  });

  it("reports step OK with failures visible in stdoutTail on partial success", () => {
    // Partial-success → stepExitCode=0 to avoid flipping the whole update to
    // error. But the progress renderer hides stderrTail on success, so the
    // failure summary must go into stdoutTail to stay visible on TTY.
    const result = summarizeRepairForUpdateStep({
      attempted: 3,
      repair: {
        repaired: [{ id: "codex" }],
        failed: [
          { id: "google", exitCode: 1, detail: "network timeout" },
          { id: "webhooks", exitCode: 1, detail: "ENOSPC" },
        ],
        skipped: [],
      },
    });

    expect(result.stepExitCode).toBe(0);
    expect(result.stderrTail).toBeNull();
    expect(result.stdoutTail).toContain("staged 1 of 3: codex");
    expect(result.stdoutTail).toContain("2 plugin(s) not staged");
    expect(result.stdoutTail).toContain("google: network timeout");
    expect(result.stdoutTail).toContain("webhooks: ENOSPC");
    expect(result.stdoutTail).toContain("openclaw doctor");
  });

  it("surfaces skipped entries (e.g. symlink refusals) alongside failures", () => {
    const result = summarizeRepairForUpdateStep({
      attempted: 2,
      repair: {
        repaired: [{ id: "codex" }],
        failed: [],
        skipped: [{ id: "attacker", reason: "not contained within extensionsDir" }],
      },
    });

    expect(result.stepExitCode).toBe(0);
    expect(result.stdoutTail).toContain("attacker: skipped");
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
        skipped: [],
      },
    });

    expect(result.stepExitCode).toBe(1);
    expect(result.stdoutTail).toBe("staged 0 of 2: (none)");
    expect(result.stderrTail).toBe("codex: network timeout\ngoogle: network timeout");
  });
});
