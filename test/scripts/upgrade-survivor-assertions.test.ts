import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstalledPluginIndex(
  stateDir: string,
  index: { installRecords: unknown; plugins: unknown },
): void {
  const sqlite = requireNodeSqlite();
  const dbPath = join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(join(stateDir, "state"), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        host_contract_version TEXT NOT NULL,
        compat_registry_version TEXT NOT NULL,
        migration_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL,
        refresh_reason TEXT,
        install_records_json TEXT NOT NULL,
        plugins_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        warning TEXT,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO installed_plugin_index (
        index_key,
        version,
        host_contract_version,
        compat_registry_version,
        migration_version,
        policy_hash,
        generated_at_ms,
        refresh_reason,
        install_records_json,
        plugins_json,
        diagnostics_json,
        warning,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "current",
      1,
      "test",
      "test",
      1,
      "test",
      1,
      null,
      JSON.stringify(index.installRecords),
      JSON.stringify(index.plugins),
      "[]",
      null,
      1,
    );
  } finally {
    db.close();
  }
}

function assertConfiguredPluginState(params: { installPath?: string } = {}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    const matrixInstallDir = params.installPath ?? join(stateDir, "extensions", "matrix");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    mkdirSync(matrixInstallDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    writeJson(join(matrixInstallDir, "package.json"), {
      name: "@openclaw/matrix",
    });
    const installedPluginIndex = {
      installRecords: {
        matrix: {
          source: "clawhub",
          spec: "clawhub:@openclaw/matrix",
          installPath: matrixInstallDir,
          clawhubPackage: "@openclaw/matrix",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
        },
      },
      plugins: [{ pluginId: "matrix", enabled: true }],
    };
    writeJson(join(stateDir, "plugins", "installs.json"), installedPluginIndex);
    writeInstalledPluginIndex(stateDir, installedPluginIndex);
    const coveragePath = join(root, "coverage.json");
    writeJson(coveragePath, {
      acceptedIntents: ["configured-plugin-installs"],
      skippedIntents: [],
    });

    execFileSync(process.execPath, [ASSERTIONS_PATH, "assert-state"], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("upgrade survivor assertions", () => {
  it("accepts official ClawHub npm-pack installs for configured external plugins", () => {
    expect(() => assertConfiguredPluginState()).not.toThrow();
  });

  it("rejects ClawHub npm-pack installs outside the managed extensions root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-outside-"));
    try {
      expect(() =>
        assertConfiguredPluginState({ installPath: join(root, "outside-matrix") }),
      ).toThrow(/managed extensions root/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
