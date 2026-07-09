/**
 * Gateway startup session migration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type StartupMigrationDeps = NonNullable<Parameters<typeof runStartupSessionMigration>[0]["deps"]>;
type MigrateSessionKeys = NonNullable<StartupMigrationDeps["migrateOrphanedSessionKeys"]>;
type ResolveStoreTargets = NonNullable<
  StartupMigrationDeps["resolveAllAgentSessionStoreTargetsSync"]
>;
type SweepStoreTemps = NonNullable<StartupMigrationDeps["sweepOrphanSessionStoreTemps"]>;

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

function makeDeps(migrate: MigrateSessionKeys, removedFiles = 0) {
  return {
    migrateOrphanedSessionKeys: migrate,
    resolveAllAgentSessionStoreTargetsSync: vi.fn<ResolveStoreTargets>().mockReturnValue([
      { agentId: "main", storePath: "/tmp/main/sessions.json" },
      { agentId: "ops", storePath: "/tmp/ops/sessions.json" },
    ]),
    sweepOrphanSessionStoreTemps: vi
      .fn<SweepStoreTemps>()
      .mockResolvedValueOnce(removedFiles)
      .mockResolvedValue(0),
  };
}

function firstLogMessage(log: ReturnType<typeof vi.fn>, label: string): string {
  const [message] = log.mock.calls[0] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected ${label} message`);
  }
  return message;
}

describe("runStartupSessionMigration", () => {
  it("logs changes when orphaned keys are canonicalized", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({
      changes: ["Canonicalized 2 orphaned session key(s) in /tmp/store.json"],
      warnings: [],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
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
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({
      changes: [],
      warnings: ["Could not read /bad/path: ENOENT"],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.warn, "startup migration warning")).toContain(
      "session key migration warnings",
    );
  });

  it("sweeps each discovered store and logs removed temp files", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const deps = makeDeps(migrate, 3);
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps,
    });
    expect(deps.sweepOrphanSessionStoreTemps).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith("session: removed 3 stale session store temp file(s)");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("catches and logs migration errors without throwing", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockRejectedValue(new Error("disk full"));
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
    });
    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup migration failure warning");
    expect(warning).toContain("migration failed during startup");
    expect(warning).toContain("disk full");
  });

  it("isolates temp-cleanup discovery failures from startup", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const deps = makeDeps(migrate);
    deps.resolveAllAgentSessionStoreTargetsSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await runStartupSessionMigration({ cfg: makeCfg(), log, deps });

    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup cleanup failure warning");
    expect(warning).toContain("temp cleanup failed during startup");
    expect(warning).toContain("permission denied");
  });
});
