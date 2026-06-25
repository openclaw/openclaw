// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
} from "../config/sessions/session-accessor.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

type TestStore = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  transcriptPath: string;
};

const previousEnv = {
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};

beforeEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  restoreEnvValue("OPENCLAW_CONFIG_PATH", previousEnv.OPENCLAW_CONFIG_PATH);
  restoreEnvValue("OPENCLAW_STATE_DIR", previousEnv.OPENCLAW_STATE_DIR);
});

describe("runDoctorSessionSqlite", () => {
  it("dry-runs a legacy store without writing SQLite rows", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "dry-run",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
      unreferencedJsonlFiles: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
  });

  it("imports and validates legacy sessions idempotently", async () => {
    const store = createLegacyStore();

    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(firstImport.totals).toMatchObject({
      archivedTranscriptFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(secondImport.totals).toMatchObject({
      archivedTranscriptFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(firstImport.targets[0]?.archivedTranscriptFiles).toHaveLength(1);
    const archivedTranscriptPath = firstImport.targets[0]?.archivedTranscriptFiles[0];
    expect(archivedTranscriptPath).toBeTruthy();
    expect(archivedTranscriptPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(fs.existsSync(archivedTranscriptPath!)).toBe(true);
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionFile,
    ).toContain("sqlite:main:session-1:");
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("imports explicit stores into the agent database owned by the path", async () => {
    const store = createLegacyStore({ agentDirName: "codex-proof" });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.targets[0]?.agentId).toBe("codex-proof");
    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "codex-proof",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("reports custom explicit store sqlite paths beside the store", async () => {
    const store = createLegacyStore({ customStore: true });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.targets[0]?.sqlitePath).toBe(
      path.join(store.sessionDir, "openclaw-agent.sqlite"),
    );
    expect(fs.existsSync(report.targets[0]!.sqlitePath)).toBe(true);
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("reports malformed transcripts without importing partial rows", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(inspect.totals.sqliteEntries).toBe(0);
  });
});

function createLegacyStore(
  params: { agentDirName?: string; customStore?: boolean; transcriptLines?: string[] } = {},
): TestStore {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
  const stateDir = path.join(tempDir, "state");
  const configPath = path.join(tempDir, "openclaw.json");
  const sessionDir = params.customStore
    ? path.join(tempDir, "legacy-session-store")
    : path.join(stateDir, "agents", params.agentDirName ?? "main", "sessions");
  const storePath = path.join(sessionDir, "sessions.json");
  const transcriptPath = path.join(sessionDir, "session-1.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          channel: "cli",
          chatType: "direct",
          sessionFile: "session-1.jsonl",
          sessionId: "session-1",
          sessionStartedAt: 1000,
          updatedAt: 2000,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    transcriptPath,
    `${(params.transcriptLines ?? ['{"type":"session","sessionId":"session-1"}', '{"type":"event","id":"evt-1"}']).join("\n")}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(sessionDir, "orphan.jsonl"), '{"type":"event"}\n', {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { configPath, env, sessionDir, stateDir, storePath, tempDir, transcriptPath };
}

function restoreEnvValue(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
