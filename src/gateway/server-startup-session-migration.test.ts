/**
 * Gateway startup session migration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type StartupSessionMigrationDeps = NonNullable<
  Parameters<typeof runStartupSessionMigration>[0]["deps"]
>;

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeCfg() {
  return { agents: { defaults: {} }, session: {} } as Parameters<
    typeof runStartupSessionMigration
  >[0]["cfg"];
}

function firstLogMessage(log: ReturnType<typeof vi.fn>, label: string): string {
  const [message] = log.mock.calls[0] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected ${label} message`);
  }
  return message;
}

function makeSessionSqliteImport(
  report: Partial<Awaited<ReturnType<StartupSessionMigrationDeps["runDoctorSessionSqlite"]>>> = {},
): StartupSessionMigrationDeps["runDoctorSessionSqlite"] {
  return vi.fn().mockResolvedValue({
    mode: "import",
    targets: [],
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      targets: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    },
    ...report,
  });
}

describe("runStartupSessionMigration", () => {
  it("logs changes when orphaned keys are canonicalized", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: ["Canonicalized 2 orphaned session key(s) in /tmp/store.json"],
      warnings: [],
    });
    const runDoctorSessionSqlite = makeSessionSqliteImport();
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate, runDoctorSessionSqlite },
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.info, "startup migration info")).toContain(
      "canonicalized orphaned session keys",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs warnings from migration", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: [],
      warnings: ["Could not read /bad/path: ENOENT"],
    });
    const runDoctorSessionSqlite = makeSessionSqliteImport();
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate, runDoctorSessionSqlite },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.warn, "startup migration warning")).toContain(
      "session key migration warnings",
    );
  });

  it("silently continues when no changes needed", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport();
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate, runDoctorSessionSqlite },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("catches and logs migration errors without throwing", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockRejectedValue(new Error("disk full"));
    const runDoctorSessionSqlite = makeSessionSqliteImport();
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate, runDoctorSessionSqlite },
    });
    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup migration failure warning");
    expect(warning).toContain("migration failed during startup");
    expect(warning).toContain("disk full");
  });

  it("imports legacy session metadata and transcripts into SQLite during startup", async () => {
    const log = makeLog();
    const cfg = makeCfg();
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
    const migrate = vi.fn().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      totals: {
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 3,
        importedTranscriptEvents: 9,
        issues: 0,
        legacyEntries: 3,
        sqliteEntries: 3,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg,
      env,
      log,
      deps: { migrateOrphanedSessionKeys: migrate, runDoctorSessionSqlite },
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });
    expect(firstLogMessage(log.info, "sqlite import info")).toContain(
      "session: imported legacy session metadata/transcripts into SQLite",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("blocks startup when hot legacy session SQLite import reports issues", async () => {
    const log = makeLog();
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 0,
          importedTranscriptEvents: 0,
          issues: [
            {
              code: "transcript_missing",
              message: "Transcript file is missing: /tmp/missing.jsonl",
              sessionKey: "agent:main:main",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 0,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 0,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await expect(
      runStartupSessionMigration({
        cfg: makeCfg(),
        log,
        deps: {
          migrateOrphanedSessionKeys: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
          runDoctorSessionSqlite,
        },
      }),
    ).rejects.toThrow("session SQLite migration failed during startup");
  });

  it("warns without blocking when only stale archive-tier JSONL archival fails", async () => {
    const log = makeLog();
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 1,
          importedTranscriptEvents: 1,
          issues: [
            {
              code: "unreferenced_jsonl_archive_failed",
              message: "/tmp/orphan.jsonl: permission denied",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 1,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: ["/tmp/orphan.jsonl"],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 1,
        importedTranscriptEvents: 1,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 1,
        targets: 1,
        unreferencedJsonlFiles: 1,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: {
        migrateOrphanedSessionKeys: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
        runDoctorSessionSqlite,
      },
    });

    expect(firstLogMessage(log.warn, "archive-tier warning")).toContain(
      "session SQLite migration warnings",
    );
  });
});
