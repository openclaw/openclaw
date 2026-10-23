import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import {
  makePreflightConfigSnapshot,
  makeStateMigrationResult,
} from "./doctor-config-preflight.state-migration.test-helpers.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";

const mocks = vi.hoisted(() => ({
  state: vi.fn(async (_params?: unknown) => makeStateMigrationResult(["imported"])),
  plugins: vi.fn(async () => makeStateMigrationResult(["plugin-imported"])),
  machine: vi.fn(() => ({ changes: ["cron-store-selection-imported"], warnings: [] })),
  cron: vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
  note: vi.fn(),
  snapshot: vi.fn(async () => ({
    ...makePreflightConfigSnapshot({}),
    includedPaths: [] as string[],
    legacyIssues: [] as LegacyConfigIssue[],
    warnings: [] as ConfigFileSnapshot["warnings"],
    issues: [] as ConfigFileSnapshot["issues"],
  })),
}));

vi.mock("../infra/state-migrations.doctor.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/state-migrations.doctor.js")>(
    "../infra/state-migrations.doctor.js",
  )),
  autoMigrateLegacyState: mocks.state,
}));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir: vi.fn(async () => makeStateMigrationResult([], false)),
}));

// mock-isolation: observe migration inputs without running plugin repairs.
vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  autoMigrateLegacyPluginDoctorState: mocks.plugins,
}));

// mock-isolation: observe machine-state migration order without changing stored state.
vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState: mocks.machine,
}));

vi.mock("../infra/state-migrations.media-persistence.js", () => ({
  migrateLegacyMediaPersistence: vi.fn(() => ({ changes: [], warnings: [] })),
}));

// mock-isolation: observe cron repair inputs without executing persistent repairs.
vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly: vi.fn(async () => ({ targets: [], warnings: [] })),
  repairLegacyCronStoreWithoutPrompt: mocks.cron,
}));

// mock-isolation: supply synthetic config snapshots without reading operator config.
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: mocks.snapshot,
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues: vi.fn((snapshot: ConfigFileSnapshot) => snapshot),
  findDoctorLegacyConfigIssues: vi.fn(() => []),
}));

// mock-isolation: capture Doctor notices without terminal output.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

const options = { migrateLegacyConfig: false, invalidConfigNote: false } as const;
const memory = {
  search: { provider: "auto", store: { vector: { enabled: false } } },
};
const memoryIssue = {
  path: "memory.search.provider",
  message: 'memory.search.provider = "auto" is legacy; use "openai" explicitly.',
};
function useInvalidConfig(
  config: Record<string, unknown>,
  legacyIssue: LegacyConfigIssue,
  overrides: Partial<Awaited<ReturnType<typeof mocks.snapshot>>> = {},
) {
  mocks.snapshot.mockResolvedValue({
    ...makePreflightConfigSnapshot(config),
    valid: false,
    includedPaths: [],
    legacyIssues: [legacyIssue],
    ...overrides,
  });
}

let restoreMigrationRuntime: (() => void) | undefined;

beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

describe("runDoctorConfigPreflight state migration input", () => {
  beforeEach(() => vi.clearAllMocks());

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

    expect(mocks.cron).toHaveBeenCalledWith({
      cfg: { cron: { store: "/tmp/custom-cron/jobs.json" } },
      migrateCodexModelRefs: false,
    });
    expect(mocks.machine).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
    });
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.plugins).toHaveBeenCalled();
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
        search: expect.objectContaining({
          provider: "openai",
          store: { vector: { enabled: false } },
        }),
      }),
      agents: expect.objectContaining({
        defaults: expect.objectContaining({}),
        entries: { main: {} },
      }),
    };
    expect(mocks.cron).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        ...migratedConfig,
        cron: expect.objectContaining({ webhook: "https://example.invalid/cron-finished" }),
      }),
      migrateCodexModelRefs: false,
    });
    expect(mocks.state).toHaveBeenCalledWith({
      cfg: expect.objectContaining(migratedConfig),
      sourceConfigBeforeMigrations: resolvedConfig,
      pluginDoctorConfig: resolvedConfig,
      configIncludedPaths: includedPaths,
      env: process.env,
      doctorOnlyStateMigrations: undefined,
      invocationPurpose: undefined,
      beforeWorkspaceStateMigration: undefined,
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

    expect(mocks.cron).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.plugins).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
      doctorOnlyStateMigrations: true,
    });
    expect(mocks.note).toHaveBeenCalledWith("- plugin-imported", "Doctor changes");
  });
});
