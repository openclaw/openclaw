// Upgrade Survivor Assertions tests cover upgrade survivor assertions script behavior.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMigratedSessionState(stateDir: string): void {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  const agentDbDir = join(stateDir, "agents", "main", "agent");
  const mainSessionFile = join(agentSessionsDir, "upgrade-main-session.jsonl");
  const directSessionFile = join(agentSessionsDir, "upgrade-direct-session.jsonl");
  const groupSessionFile = join(agentSessionsDir, "upgrade-group-session.jsonl");
  mkdirSync(agentSessionsDir, { recursive: true });
  mkdirSync(agentDbDir, { recursive: true });
  writeFileSync(mainSessionFile, '{"type":"main"}\n');
  writeFileSync(directSessionFile, '{"type":"direct"}\n');
  writeFileSync(groupSessionFile, '{"type":"group"}\n');

  const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        blob BLOB,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
    const insert = db.prepare(`
      INSERT INTO cache_entries (scope, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(
      "session_entries",
      "agent:main:main",
      JSON.stringify({
        sessionFile: mainSessionFile,
        sessionId: "upgrade-main-session",
        skillsSnapshot: {
          prompt: "legacy prompt survives as metadata",
        },
      }),
      1710000000000,
    );
    insert.run(
      "session_entries",
      "agent:main:+15551234567",
      JSON.stringify({
        sessionFile: directSessionFile,
        sessionId: "upgrade-direct-session",
      }),
      1710000000100,
    );
    insert.run(
      "session_entries",
      "agent:main:slack:channel:cupgrade",
      JSON.stringify({
        sessionFile: groupSessionFile,
        sessionId: "upgrade-group-session",
      }),
      1710000000200,
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
    writeMigratedSessionState(stateDir);
    writeJson(join(matrixInstallDir, "package.json"), {
      name: "@openclaw/matrix",
    });
    writeJson(join(stateDir, "plugins", "installs.json"), {
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
    });
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
