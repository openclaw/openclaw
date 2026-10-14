// Plugin Update Unchanged Docker tests cover plugin update unchanged docker script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadInstalledPluginIndex } from "../../src/plugins/installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "../../src/plugins/installed-plugin-package-ownership.js";
import { closeOpenClawStateDatabaseByPath } from "../../src/state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
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

function runProbe(command: string, payload: unknown): void {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
  const payloadPath = path.join(root, "payload.json");
  try {
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    execFileSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, command, payloadPath, CORRUPT_PLUGIN_ID], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runProbeStatus(
  command: string,
  payload: unknown,
): { status: number | null; stderr: string } {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
  const payloadPath = path.join(root, "payload.json");
  try {
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    const result = spawnSync(
      "node",
      [PLUGIN_UPDATE_PROBE_SCRIPT, command, payloadPath, CORRUPT_PLUGIN_ID],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function corruptPolicyConfig(
  allow: unknown,
  codexEnabled = false,
  corruptEntry = { enabled: false },
) {
  return {
    plugins: {
      allow,
      entries: { [CORRUPT_PLUGIN_ID]: corruptEntry, codex: { enabled: codexEnabled } },
    },
  };
}

function runProbeFileStatus(
  command: string,
  filePath: string,
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, command, filePath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return { status: result.status, stderr: result.stderr };
}

function runCorruptUpdateDockerBaseline(env: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-corrupt-update-docker-"));
  const binDir = path.join(root, "bin");
  const dockerArgsPath = path.join(root, "docker-args");
  const packagePath = path.join(root, "candidate.tgz");
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("plugin update unchanged Docker E2E", () => {
  it.each([false, true])(
    "seeds plugin ownership with initialized state=%s",
    async (initialized) => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-seed-"));
      try {
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
        expect(persisted.installRecords).toMatchObject({
          "lossless-claw": {
            source: "npm",
            installPath: "~/.openclaw/extensions/lossless-claw",
          },
        });
        expect(persisted.plugins).toEqual([
          expect.objectContaining({
            pluginId: "lossless-claw",
            installOwner: "lossless-claw",
            rootDir: path.join(stateDir, "extensions", "lossless-claw"),
          }),
        ]);

        const database = openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseByPath(database.path);
        const liveIndex = loadInstalledPluginIndex({
          config,
          env,
          stateDir,
        });
        expect(
          createInstalledPluginOwnershipResolver(liveIndex, env).resolvePackage("lossless-claw"),
        ).toMatchObject({
          ok: true,
          value: {
            installOwner: "lossless-claw",
            pluginIds: ["lossless-claw"],
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("bounds assert-output diagnostics to the saved command log tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
    const logPath = path.join(root, "plugin-update-output.log");
    try {
      writeFileSync(
        logPath,
        `DO_NOT_PRINT_OLD_PLUGIN_UPDATE_LOG\n${"filler line\n".repeat(12 * 1024)}missing marker tail`,
        "utf8",
      );

      const result = runProbeFileStatus("assert-output", logPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Expected up-to-date output missing");
      expect(result.stderr).toContain("Output tail:");
      expect(result.stderr).toContain("missing marker tail");
      expect(result.stderr).not.toContain("DO_NOT_PRINT_OLD_PLUGIN_UPDATE_LOG");
      expect(result.stderr.length).toBeLessThan(80 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects unexpected download output before a large log tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
    const logPath = path.join(root, "plugin-update-output.log");
    try {
      writeFileSync(
        logPath,
        [
          "Downloading @example/lossless-claw",
          "filler line\n".repeat(12 * 1024),
          "lossless-claw is up to date (0.9.0).",
        ].join("\n"),
        "utf8",
      );

      const result = runProbeFileStatus("assert-output", logPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unexpected npm download/reinstall path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["2026.9.2"])(
    "keeps a historical %s override out of the same-schema repair lane",
    (version) => {
      const result = runCorruptUpdateDockerBaseline({
        OPENCLAW_UPDATE_CORRUPT_PLUGIN_BASELINE: `openclaw@${version}`,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: `openclaw@${version}`,
      });
      expect(result.result.status, result.result.stderr).toBe(0);
      expect(result.baseline).toBeUndefined();
    },
  );

  it.each([
    ["target-owned additions", { enabled: false }, [CORRUPT_PLUGIN_ID, "memory-core", "codex"]],
  ])("preserves the explicit allow policy after %s recovery", (_recovery, entry, allow) => {
    expect(() =>
      runProbe("assert-corrupt-policy-preserved", corruptPolicyConfig(allow, false, entry)),
    ).not.toThrow();
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
    const result = runProbeStatus(
      "assert-corrupt-policy-preserved",
      corruptPolicyConfig(allow, codexEnabled),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });
});
