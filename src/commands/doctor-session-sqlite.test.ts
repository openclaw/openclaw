// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
  upsertSqliteSessionEntry,
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
  unreferencedJsonlPath: string;
  trajectoryPath: string;
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
      unreferencedJsonlFiles: 2,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects a legacy store without creating a SQLite database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects SQLite-only all-agent targets without requiring a legacy store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await upsertSqliteSessionEntry(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "sqlite-session", updatedAt: Date.now() },
      );

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {},
        env,
        mode: "inspect",
      });

      expect(fs.existsSync(storePath)).toBe(false);
      expect(report.totals).toMatchObject({
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
        targets: 1,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(secondImport.totals).toMatchObject({
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.trajectoryPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(firstImport.targets[0]?.archivedTranscriptFiles).toHaveLength(2);
    for (const archivedTranscriptPath of firstImport.targets[0]?.archivedTranscriptFiles ?? []) {
      expect(archivedTranscriptPath).toBeTruthy();
      expect(archivedTranscriptPath).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(fs.existsSync(archivedTranscriptPath)).toBe(true);
    }
    expect(firstImport.targets[0]?.archivedUnreferencedJsonlFiles).toHaveLength(1);
    const archivedUnreferencedPath = firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0];
    expect(archivedUnreferencedPath).toBeTruthy();
    expect(archivedUnreferencedPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(archivedUnreferencedPath).toContain("archive-tier.orphan.jsonl.imported-");
    expect(fs.existsSync(archivedUnreferencedPath)).toBe(true);
    expect(fs.readFileSync(archivedUnreferencedPath, "utf-8")).toBe('{"type":"event"}\n');
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(inspect.totals.unreferencedJsonlFiles).toBe(0);
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

  it("validates missing SQLite rows without creating the agent database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 1,
      sqliteEntries: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_entry_missing",
      sessionKey: "agent:main:main",
    });
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("imports aliases that share one legacy transcript before archiving it", async () => {
    const store = createLegacyStore();
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 2,
      importedEntries: 2,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 2,
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:alias",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
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

  it("imports legacy entries even when their transcript sidecar is missing", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_missing",
      sessionKey: "agent:main:main",
    });
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toEqual([]);
  });

  it("imports shared custom stores into per-agent SQLite targets", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
      const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
      const orphanTranscriptPath = path.join(sessionDir, "orphan.jsonl");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionFile: "main-session.jsonl",
              sessionId: "main-session",
              updatedAt: 20,
            },
            "agent:work:main": {
              sessionFile: "work-session.jsonl",
              sessionId: "work-session",
              updatedAt: 30,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n', {
        mode: 0o600,
      });
      fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n', {
        mode: 0o600,
      });
      fs.writeFileSync(orphanTranscriptPath, '{"type":"event","id":"orphan"}\n', { mode: 0o600 });

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

      expect(report.targets.map((target) => target.agentId)).toEqual(["main", "work"]);
      expect(report.totals).toMatchObject({
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        issues: 0,
        sqliteEntries: 2,
      });
      expect(
        loadExactSqliteSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSqliteSessionEntry({
          agentId: "work",
          sessionKey: "agent:work:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("work-session");
      expect(fs.existsSync(mainTranscriptPath)).toBe(false);
      expect(fs.existsSync(workTranscriptPath)).toBe(false);
      expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports active JSONL files left beside SQLite-backed sessions", async () => {
    const store = createLegacyStore();

    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"heartbeat"}\n', {
      mode: 0o600,
    });
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        sessionFile: "session-1.jsonl",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "active_sqlite_transcript_jsonl",
      sessionKey: "agent:main:main",
    });
    expect(report.targets[0]?.issues[0]?.message).toContain("session-1.jsonl");
  });

  it("reports active JSONL scan failures without aborting inspect", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_active_transcript_scan_failed");
  });

  it("does not truncate existing SQLite transcript rows when re-importing a duplicate fragment", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"message","id":"msg-1","message":{"role":"user","content":"first"}}',
        '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}',
      ],
    });

    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(store.trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
      mode: 0o600,
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 2,
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 0,
    });
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(3);
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
    expect(fs.existsSync(report.targets[0]?.sqlitePath)).toBe(true);
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
    expect(report.totals.archivedUnreferencedJsonlFiles).toBe(0);
    expect(report.totals.unreferencedJsonlFiles).toBe(2);
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
    expect(inspect.totals.sqliteEntries).toBe(0);
  });

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      { sessionId: "session-1", updatedAt: 2000 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 2,
      sqliteEntries: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_malformed",
      sessionKey: "agent:main:main",
    });
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
  const trajectoryPath = path.join(sessionDir, "session-1.trajectory.jsonl");
  const unreferencedJsonlPath = path.join(sessionDir, "orphan.jsonl");
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
  fs.writeFileSync(trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(unreferencedJsonlPath, '{"type":"event"}\n', {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return {
    configPath,
    env,
    sessionDir,
    stateDir,
    storePath,
    tempDir,
    unreferencedJsonlPath,
    trajectoryPath,
    transcriptPath,
  };
}

function restoreEnvValue(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
