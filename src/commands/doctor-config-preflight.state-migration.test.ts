// Doctor config preflight tests cover state migration preflight behavior before config repair.
import { beforeEach, describe, expect, it, vi } from "vitest";

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: false, skipped: false, changes: [], warnings: [] })),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: true, skipped: false, changes: ["imported"], warnings: [] })),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(async () => ({ migrated: true, skipped: false, changes: ["task-imported"], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    sourceConfig: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    issues: [] as Array<{ path: string; message: string }>,
  })),
);
const note = vi.hoisted(() => vi.fn());

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("./doctor/cron/index.js", () => ({
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight state migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the startup guard immediately before the first state mutation", async () => {
    const beforeStateMigrations = vi.fn<(_snapshot?: unknown) => Promise<boolean>>(
      async () => true,
    );

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    const guardOrder = beforeStateMigrations.mock.invocationCallOrder[0] ?? 0;
    const firstMutationOrder = autoMigrateLegacyStateDir.mock.invocationCallOrder[0] ?? 0;
    expect(firstMutationOrder).toBeGreaterThan(guardOrder);
    const configGuardOrder = beforeStateMigrations.mock.invocationCallOrder[1] ?? 0;
    const configMutationOrder = repairLegacyCronStoreWithoutPrompt.mock.invocationCallOrder[0] ?? 0;
    expect(configMutationOrder).toBeGreaterThan(configGuardOrder);
    expect(beforeStateMigrations.mock.calls[1]?.[0]).toMatchObject({
      valid: true,
      sourceConfig: { gateway: { mode: "local", port: 19091 } },
    });
  });

  it("skips every state migration stage when the startup guard rejects", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations: async () => false,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
  });

  it("skips config-dependent migrations when the fresh snapshot guard rejects", async () => {
    const beforeStateMigrations = vi
      .fn<(snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });

  it("runs full state migrations after reading the config snapshot", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: undefined,
    });
    expect(note).toHaveBeenCalledWith("- cron-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- imported", "Doctor changes");
  });

  it("passes explicit corrupt-target recovery to state migrations", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      recoverCorruptTargetStore: true,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      recoverCorruptTargetStore: true,
    });
  });

  it("limits invalid-config preflight to config-independent state migration", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: { cron: { store: "/tmp/legacy-cron.json" } },
      sourceConfig: { cron: { store: "/tmp/legacy-cron.json" } },
      legacyIssues: [],
      warnings: [],
      issues: [{ path: "gateway", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });
});
