import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { loadInstalledPluginIndex } from "../../src/plugins/installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "../../src/plugins/installed-plugin-package-ownership.js";
import { closeOpenClawStateDatabaseByPath } from "../../src/state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CORRUPT_UPDATE_DOCKER_SCRIPT = "scripts/e2e/update-corrupt-plugin-docker.sh";
const PLUGIN_UPDATE_PROBE_SCRIPT = "scripts/e2e/lib/plugin-update/probe.mjs";
const CORRUPT_PLUGIN_ID = "demo-corrupt-plugin";
const PLUGIN_INDEX_MODULE_URL = pathToFileURL(
  path.resolve("scripts/e2e/lib/plugin-index-sqlite.mjs"),
).href;

function seedInstallState(root: string, initialized: boolean) {
  const stateDir = path.join(root, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const env = {
    ...process.env,
    HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VERSION: "2026.8.1",
    VITEST: "true",
  };
  if (initialized) {
    const database = openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseByPath(database.path);
  }
  execFileSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, "seed"], {
    encoding: "utf8",
    env,
    stdio: "pipe",
  });
  return { configPath, env, stateDir };
}

function runPolicyProbe(allow: unknown, codexEnabled = false) {
  const root = tempDirs.make("openclaw-plugin-update-probe-");
  const payloadPath = path.join(root, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      plugins: {
        allow,
        entries: { [CORRUPT_PLUGIN_ID]: { enabled: false }, codex: { enabled: codexEnabled } },
      },
    }),
  );
  return runProbeFileStatus("assert-corrupt-policy-preserved", payloadPath, CORRUPT_PLUGIN_ID);
}

function runProbeFileStatus(command: string, filePath: string, ...args: string[]) {
  return spawnSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, command, filePath, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function runCorruptUpdateDockerBaseline(env: Record<string, string>) {
  const root = tempDirs.make("openclaw-corrupt-update-docker-");
  const binDir = path.join(root, "bin");
  const dockerArgsPath = path.join(root, "docker-args");
  const packagePath = path.join(root, "candidate.tgz");
  mkdirSync(binDir);
  writeFileSync(packagePath, "fake package");
  writeFileSync(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" ]]; then
  printf '%s\n' "$@" > "$DOCKER_ARGS_PATH"
fi
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [CORRUPT_UPDATE_DOCKER_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_ARGS_PATH: dockerArgsPath,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...env,
    },
  });
  const dockerArgs = existsSync(dockerArgsPath) ? readFileSync(dockerArgsPath, "utf8") : "";
  return {
    baseline: dockerArgs
      .split("\n")
      .find((entry) => entry.startsWith("OPENCLAW_UPDATE_CORRUPT_PLUGIN_BASELINE=")),
    result,
  };
}

it.each([false, true])(
  "preserves plugin ownership with initialized state=%s",
  async (initialized) => {
    const root = tempDirs.make("openclaw-plugin-update-seed-");
    const { configPath, env, stateDir } = seedInstallState(root, initialized);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    expect(config).toEqual({ plugins: {} });
    expect(
      JSON.parse(
        execFileSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, "snapshot"], {
          encoding: "utf8",
          env,
        }),
      ),
    ).toMatchObject({ source: "npm", resolvedVersion: "0.9.0" });

    const { readPluginInstallIndex } = await import(PLUGIN_INDEX_MODULE_URL);
    const persisted = readPluginInstallIndex({ configPath, stateDir });
    expect(persisted).toMatchObject({
      installRecords: {
        "lossless-claw": {
          source: "npm",
          installPath: "~/.openclaw/extensions/lossless-claw",
        },
      },
      plugins: [
        {
          pluginId: "lossless-claw",
          installOwner: "lossless-claw",
          rootDir: path.join(stateDir, "extensions", "lossless-claw"),
        },
      ],
    });

    if (!initialized) {
      // The frozen-driver probe can seed an unversioned plugin-only catalog, but it
      // is not a native credential bootstrap that the current runtime may adopt.
      expect(() => openOpenClawStateDatabase({ env })).toThrow(
        "Unrecognized native bootstrap database",
      );
      expect(readPluginInstallIndex({ configPath, stateDir })).toEqual(persisted);
      expect(existsSync(path.join(stateDir, "client"))).toBe(false);
      return;
    }

    const database = openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseByPath(database.path);
    const liveIndex = loadInstalledPluginIndex({ config, env, stateDir });
    expect(
      createInstalledPluginOwnershipResolver(liveIndex, env).resolvePackage("lossless-claw"),
    ).toMatchObject({
      ok: true,
      value: { installOwner: "lossless-claw", pluginIds: ["lossless-claw"] },
    });
  },
);

it.each([
  [
    "bounds saved diagnostics",
    "DO_NOT_PRINT_OLD_PLUGIN_UPDATE_LOG",
    "missing marker tail",
    "Expected up-to-date output missing",
  ],
  [
    "detects downloads before the tail",
    "Downloading @example/lossless-claw",
    "lossless-claw is up to date (0.9.0).",
    "Unexpected npm download/reinstall path",
  ],
])("assert-output %s", (_name, prefix, suffix, error) => {
  const root = tempDirs.make("openclaw-plugin-update-probe-");
  const logPath = path.join(root, "plugin-update-output.log");
  writeFileSync(logPath, `${prefix}\n${"filler line\n".repeat(12 * 1024)}${suffix}`, "utf8");

  const result = runProbeFileStatus("assert-output", logPath);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
  if (suffix === "missing marker tail") {
    expect(result.stderr).toContain("Output tail:");
    expect(result.stderr).toContain(suffix);
    expect(result.stderr).not.toContain(prefix);
    expect(result.stderr.length).toBeLessThan(80 * 1024);
  }
});

it("keeps a historical override out of the same-schema repair lane", () => {
  const result = runCorruptUpdateDockerBaseline({
    OPENCLAW_UPDATE_CORRUPT_PLUGIN_BASELINE: "openclaw@2026.9.2",
    OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.9.2",
  });
  expect(result.result.status, result.result.stderr).toBe(0);
  expect(result.baseline).toBeUndefined();
});

it("preserves the explicit allow policy after target-owned additions", () => {
  const result = runPolicyProbe([CORRUPT_PLUGIN_ID, "memory-core", "codex"]);
  expect(result.status, result.stderr).toBe(0);
});

it.each([
  ["non-array allow policy", CORRUPT_PLUGIN_ID, false, "plugins.allow to be an array"],
  ["missing fixture membership", ["memory-core"], false, "exactly once"],
  [
    "loss of the Codex opt-out",
    [CORRUPT_PLUGIN_ID],
    true,
    "explicit Codex opt-out to survive, got true",
  ],
])("rejects corrupt update recovery with %s", (_case, allow, codexEnabled, expectedError) => {
  const result = runPolicyProbe(allow, codexEnabled);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(expectedError);
});
