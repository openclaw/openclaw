import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import { makeStateMigrationResult } from "./doctor-config-preflight.state-migration.test-helpers.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";

const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => makeStateMigrationResult(["imported"])),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(async () => makeStateMigrationResult(["plugin-imported"])),
);
const migrateLegacyConfigMachineState = vi.hoisted(() =>
  vi.fn(() => ({ changes: ["cron-store-selection-imported"], warnings: [] })),
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
    parsed: { gateway: { mode: "local", port: 19091 } } as Record<string, unknown>,
    includedPaths: [] as string[],
    legacyIssues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    issues: [] as Array<{ path: string; message: string }>,
  })),
);
const note = vi.hoisted(() => vi.fn());

vi.mock("../infra/state-migrations.doctor.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/state-migrations.doctor.js")>(
    "../infra/state-migrations.doctor.js",
  )),
  autoMigrateLegacyState,
}));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir: vi.fn(async () => makeStateMigrationResult([], false)),
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  autoMigrateLegacyPluginDoctorState,
}));

vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState,
}));

vi.mock("../infra/state-migrations.media-persistence.js", () => ({
  migrateLegacyMediaPersistence: vi.fn(() => ({ changes: [], warnings: [] })),
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly: vi.fn(async () => ({ targets: [], warnings: [] })),
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues: vi.fn((snapshot: ConfigFileSnapshot) => snapshot),
  findDoctorLegacyConfigIssues: vi.fn(() => []),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

const options = { migrateLegacyConfig: false, invalidConfigNote: false } as const;
const memory = {
  search: { store: { path: "/custom/memory-{agentId}.sqlite", vector: { enabled: false } } },
};
const memoryIssue = {
  path: "memory.search.store.path",
  message: "memory.search.store.path is legacy; memory indexes now live in each agent database.",
};
function useInvalidConfig(
  config: Record<string, unknown>,
  legacyIssue: LegacyConfigIssue,
  overrides: Partial<Awaited<ReturnType<typeof readConfigFileSnapshot>>> = {},
) {
  readConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: false,
    config,
    sourceConfig: config,
    parsed: config,
    includedPaths: [],
    legacyIssues: [legacyIssue],
    warnings: [],
    issues: [],
    ...overrides,
  });
}

let restoreMigrationRuntime: (() => void) | undefined;

beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

describe("runDoctorConfigPreflight state migration input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshot.mockReset();
  });

  it("passes explicit corrupt-target recovery to state migrations", async () => {
    await runDoctorConfigPreflight({
      ...options,
      recoverCorruptTargetStore: true,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      configIncludedPaths: [],
      env: process.env,
      log: undefined,
      recoverCorruptTargetStore: true,
      doctorOnlyStateMigrations: undefined,
      onStepReceipt: expect.any(Function),
    });
  });

  it("preserves a retired custom cron partition with invalid Gateway config", async () => {
    const sourceConfig = {
      gateway: { mode: "local", port: "not-a-port" },
      agents: {
        entries: { ops: {}, research: {} },
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
          authInheritance: { agentId: "ops" },
        },
      },
      cron: { store: "/tmp/custom-cron/jobs.json" },
      talk: { agentId: "ops" },
    };
    useInvalidConfig(
      sourceConfig,
      { path: "cron.store", message: "cron.store is retired" },
      {
        parsed: {
          agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
          cron: { store: "/tmp/custom-cron/jobs.json" },
        },
        issues: [{ path: "gateway.port", message: "invalid port" }],
      },
    );

    await runDoctorConfigPreflight(options);

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { cron: { store: "/tmp/custom-cron/jobs.json" } },
      migrateCodexModelRefs: false,
    });
    expect(migrateLegacyConfigMachineState).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
    });
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalled();
  });

  it("runs plugin state migrations with resolved legacy config before config repair removes retired paths", async () => {
    const parsedConfig = { $include: "memory-search.json" };
    const includedPaths = ["/tmp/base.json", "/tmp/memory-search.json"];
    const resolvedConfig = {
      cron: { webhook: "https://example.invalid/cron-finished" },
      memory,
      agents: {
        defaults: {},
        entries: { main: {} },
      },
    };
    useInvalidConfig(resolvedConfig, memoryIssue, { parsed: parsedConfig, includedPaths });

    await runDoctorConfigPreflight(options);

    const migratedConfig = {
      memory: expect.objectContaining({
        search: expect.objectContaining({ store: { vector: { enabled: false } } }),
      }),
      agents: expect.objectContaining({
        defaults: expect.objectContaining({}),
        entries: { main: {} },
      }),
    };
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        ...migratedConfig,
        cron: expect.objectContaining({ webhook: "https://example.invalid/cron-finished" }),
      }),
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: expect.objectContaining(migratedConfig),
      pluginDoctorConfig: resolvedConfig,
      configIncludedPaths: includedPaths,
      env: process.env,
      log: undefined,
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
      onStepReceipt: expect.any(Function),
    });
  });

  it("keeps explicit Doctor repair authority for partially valid legacy config", async () => {
    const resolvedConfig = {
      gateway: { mode: "local", port: "not-a-port" },
      memory,
      agents: {
        defaults: {},
        list: [{ id: "main" }],
      },
    };
    useInvalidConfig(resolvedConfig, memoryIssue, {
      issues: [{ path: "gateway.port", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      ...options,
      doctorOnlyStateMigrations: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
      doctorOnlyStateMigrations: true,
    });
    expect(note).toHaveBeenCalledWith("- plugin-imported", "Doctor changes");
  });
});
