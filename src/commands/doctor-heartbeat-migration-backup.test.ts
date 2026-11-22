import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";

const mocks = vi.hoisted(() => ({
  prepareDoctorDatabaseMigrations: vi.fn(),
  backupDoctorMigrationDatabases: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  tryProjectRetiredHeartbeatConfig: vi.fn(),
  hasPendingHeartbeatCadenceMigration: vi.fn(),
  collectHeartbeatScratchMigrationFindings: vi.fn(),
  hasPendingHeartbeatOutcomes: vi.fn(),
}));

vi.mock("./doctor-schema-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-schema-migrations.js")>()),
  prepareDoctorDatabaseMigrations: mocks.prepareDoctorDatabaseMigrations,
}));
vi.mock("./doctor-migration-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-migration-backup.js")>()),
  backupDoctorMigrationDatabases: mocks.backupDoctorMigrationDatabases,
}));
vi.mock("../config/io.factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.factory.js")>()),
  createConfigIO: () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }),
}));
vi.mock("./doctor-heartbeat-legacy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-heartbeat-legacy.js")>()),
  tryProjectRetiredHeartbeatConfig: mocks.tryProjectRetiredHeartbeatConfig,
}));
vi.mock("./doctor-heartbeat-cadence-migration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-heartbeat-cadence-migration.js")>()),
  hasPendingHeartbeatCadenceMigration: mocks.hasPendingHeartbeatCadenceMigration,
}));
vi.mock("./doctor-heartbeat-scratch-migration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-heartbeat-scratch-migration.js")>()),
  collectHeartbeatScratchMigrationFindings: mocks.collectHeartbeatScratchMigrationFindings,
}));
vi.mock("./doctor-heartbeat-outcome-migration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-heartbeat-outcome-migration.js")>()),
  hasPendingHeartbeatOutcomes: mocks.hasPendingHeartbeatOutcomes,
}));

const { prepareDoctorMigrationBackups } = await import("./doctor-heartbeat-migration-backup.js");

const agentPath = "/state/agents/main/agent/openclaw-agent.sqlite";
const otherAgentPath = "/state/agents/ops/agent/openclaw-agent.sqlite";
const pending = (path: string) => ({
  kind: "agent" as const,
  path,
  foundVersion: 31,
  supportedVersion: 32,
});

function schemasWith(
  pendingMigrations: ReturnType<typeof pending>[],
  extra: Partial<DoctorDatabasePreflight> = {},
): DoctorDatabasePreflight {
  return { incompatible: [], indeterminate: [], pendingMigrations, ...extra };
}

describe("prepareDoctorMigrationBackups", () => {
  const runtime = { log: vi.fn() };
  const measure = <T>(_name: string, run: () => T | Promise<T>) => Promise.resolve(run());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backupDoctorMigrationDatabases.mockResolvedValue({ changes: [], warnings: [] });
    mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig: {} });
    mocks.tryProjectRetiredHeartbeatConfig.mockReturnValue(undefined);
  });

  const run = (schemas: DoctorDatabasePreflight) =>
    prepareDoctorMigrationBackups({
      schemas,
      env: {},
      check: "quick",
      verifiedSnapshots: [],
      automaticRepair: false,
      runtime,
      measure,
    });

  it("keeps stores the version phase did not migrate pending", async () => {
    mocks.prepareDoctorDatabaseMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      versionMigrations: [pending(agentPath)],
    });

    await run(schemasWith([pending(agentPath), pending(otherAgentPath)]));

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.backupDoctorMigrationDatabases).toHaveBeenCalledOnce();
  });

  it("keeps unreadable stores pending", async () => {
    mocks.prepareDoctorDatabaseMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      versionMigrations: [],
    });

    await run(
      schemasWith([], {
        indeterminate: [{ kind: "agent", path: otherAgentPath, reason: "unreadable" }],
      }),
    );

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.backupDoctorMigrationDatabases).toHaveBeenCalledOnce();
  });

  it("keeps the full rollback group when the version phase did not run", async () => {
    mocks.prepareDoctorDatabaseMigrations.mockResolvedValue({ changes: [], warnings: [] });

    await run(schemasWith([pending(agentPath)]));

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.backupDoctorMigrationDatabases).toHaveBeenCalledOnce();
  });
});
