import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { StateMigrationResult } from "./doctor-config-preflight.state-migration.test-helpers.js";

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  })),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(async (_params?: unknown): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["imported"],
    warnings: [],
  })),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["plugin-imported"],
    warnings: [],
  })),
);
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => ({
    migrated: true,
    skipped: false,
    changes: ["task-imported"],
    warnings: [],
  })),
);
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const migrateLegacyConfigMachineState = vi.hoisted(() =>
  vi.fn(() => ({ changes: ["cron-store-selection-imported"], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: ["cron-imported"], warnings: [] })),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [], warnings: [] })),
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
const findDoctorLegacyConfigIssues = vi.hoisted(() =>
  vi.fn((_raw: unknown, _sourceRaw?: unknown): LegacyConfigIssue[] => []),
);
const addDoctorLegacyIssues = vi.hoisted(() =>
  vi.fn((snapshot: ConfigFileSnapshot): ConfigFileSnapshot => {
    if (!snapshot.exists) {
      return snapshot;
    }
    const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
    const sourceRaw = snapshot.parsed ?? resolvedRaw;
    const legacyIssues = findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
    return legacyIssues.length === 0 ? snapshot : { ...snapshot, legacyIssues };
  }),
);
const note = vi.hoisted(() => vi.fn());
const rehearsal = vi.hoisted(() =>
  vi.fn(async () => ({ copiedFiles: 2, warnings: ["rehearsal advisory"] })),
);
vi.mock("../infra/update-candidate-plugin-repair.js", () => ({
  completeUpdateCandidatePluginRehearsal: rehearsal,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../infra/state-migrations.doctor.js", () => ({
  autoMigrateLegacyState,
}));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  autoMigrateLegacyPluginDoctorState,
}));

vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState,
}));

vi.mock("../infra/state-migrations.media-persistence.js", () => ({
  migrateLegacyMediaPersistence,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues,
  findDoctorLegacyConfigIssues,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

function retiredInstallSnapshot(
  options: {
    legacyLocator?: boolean;
    invalidRecord?: boolean;
    invalidRemainder?: boolean;
  } = {},
) {
  const sourceConfig = {
    gateway: { mode: "local", port: options.invalidRemainder ? "invalid" : 19091 },
    agents: { ownership: "explicit", entries: { alpha: {}, bravo: {} } },
    plugins: {
      enabled: false,
      installs: {
        fixture: {
          source: options.invalidRecord ? "invalid" : "npm",
          spec: "@fixture/migration",
          installPath: "/retained/plugin",
        },
      },
    },
    ...(options.legacyLocator
      ? { memory: { search: { store: { path: "/retained/memory.sqlite" } } } }
      : {}),
  };
  return {
    exists: true,
    valid: false,
    raw: `${JSON.stringify(sourceConfig, null, 2)}\n`,
    config: sourceConfig,
    sourceConfig,
    parsed: sourceConfig,
    includedPaths: [],
    legacyIssues: options.legacyLocator
      ? [{ path: "memory.search.store.path", message: "memory index path is retired" }]
      : [],
    warnings: [],
    issues: [{ path: "plugins.installs", message: "plugin install records are retired" }],
  };
}

describe("runDoctorConfigPreflight state migration input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDoctorLegacyConfigIssues.mockReset();
    findDoctorLegacyConfigIssues.mockReturnValue([]);
  });

  it("passes explicit corrupt-target recovery to state migrations", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
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

  it("passes explicit Doctor-only migration authority only when requested", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      doctorOnlyStateMigrations: true,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: true }),
    );
  });

  it.each([false, true])(
    "requires completed plugin convergence before admitting retired install records (converged=%s)",
    async (converged) => {
      const snapshot = retiredInstallSnapshot();
      const original = structuredClone(snapshot);
      readConfigFileSnapshot.mockResolvedValueOnce(snapshot);

      const result = await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        ...(converged ? { migrationPluginsConverged: true as const } : {}),
      });

      if (converged) {
        expect(autoMigrateLegacyState).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            cfg: expect.objectContaining({
              gateway: snapshot.sourceConfig.gateway,
              agents: snapshot.sourceConfig.agents,
              plugins: { enabled: false },
            }),
            pluginDoctorConfig: snapshot.sourceConfig,
            doctorOnlyStateMigrations: true,
          }),
        );
      } else {
        expect(autoMigrateLegacyState).not.toHaveBeenCalled();
      }
      expect(result.snapshot.sourceConfig).toEqual(original.sourceConfig);
      expect(snapshot).toEqual(original);
    },
  );

  it.each([false, true])(
    "keeps rehearsal completion separate from migration convergence (%s)",
    async (converged) => {
      const snapshot = retiredInstallSnapshot();
      const original = structuredClone(snapshot);
      readConfigFileSnapshot.mockResolvedValueOnce(snapshot);
      await withEnvAsync(
        {
          ...buildUpdateRehearsalPathEnv(dirs.make("preflight-convergence-rehearsal-")),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        },
        async () => {
          const result = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            doctorOnlyStateMigrations: true,
            ...(converged ? { migrationPluginsConverged: true as const } : {}),
          });
          expect(rehearsal).toHaveBeenCalledTimes(1);
          expect(autoMigrateLegacyState).toHaveBeenCalledTimes(converged ? 1 : 0);
          expect(note).toHaveBeenCalledWith(
            expect.stringContaining("rehearsal advisory"),
            expect.any(String),
          );
          expect(result.snapshot.sourceConfig).toEqual(original.sourceConfig);
          expect(snapshot).toEqual(original);
        },
      );
    },
  );

  it.each(["record", "remainder"] as const)(
    "does not admit an invalid %s using plugin convergence proof",
    async (invalid) => {
      const snapshot = retiredInstallSnapshot({
        invalidRecord: invalid === "record",
        invalidRemainder: invalid === "remainder",
      });
      const original = structuredClone(snapshot);
      readConfigFileSnapshot.mockResolvedValueOnce(snapshot);

      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        migrationPluginsConverged: true,
      });

      expect(autoMigrateLegacyState).not.toHaveBeenCalled();
      expect(autoMigrateLegacyPluginDoctorState).not.toHaveBeenCalled();
      expect(snapshot).toEqual(original);
    },
  );

  it.each(["completed", "refused"] as const)(
    "settles required migration before returning the source config for retirement (%s)",
    async (outcome) => {
      const snapshot = retiredInstallSnapshot({ legacyLocator: true });
      const original = structuredClone(snapshot);
      const receipt: LegacyStateMigrationStepReceipt = {
        id: "plugin-doctor-state",
        phase: "final",
        source: [{ kind: "path", path: "/retained/binding.json" }],
        target: [{ kind: "owner", id: "fixture" }],
        requiredness: "required",
        reversibility: "checkpoint-required",
        outcome,
        changes: outcome === "completed" ? ["binding imported"] : [],
        warnings: outcome === "refused" ? ["binding import refused"] : [],
        ...(outcome === "refused"
          ? { refusal: { code: "fixture-refused", message: "binding import refused" } }
          : {}),
      };
      readConfigFileSnapshot.mockResolvedValueOnce(snapshot);
      autoMigrateLegacyState.mockImplementationOnce(async (input) => {
        const params = input as Parameters<
          typeof import("../infra/state-migrations.doctor.js").autoMigrateLegacyState
        >[0];
        expect(snapshot).toEqual(original);
        expect(params.cfg).not.toHaveProperty("plugins.installs");
        expect(params.cfg).not.toHaveProperty("memory.search.store.path");
        expect(params.pluginDoctorConfig).toEqual(original.sourceConfig);
        params.onStepReceipt?.(receipt);
        return {
          migrated: outcome === "completed",
          skipped: false,
          changes: receipt.changes,
          warnings: receipt.warnings,
        };
      });

      const preflight = runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        migrationPluginsConverged: true,
      });
      if (outcome === "refused") {
        await expect(preflight).rejects.toThrow("a state migration refused to continue");
      } else {
        const result = await preflight;
        expect(result.stateMigrationStepReceipts).toEqual([receipt]);
        expect(result.snapshot.sourceConfig).toEqual(original.sourceConfig);
      }
      expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
      expect(snapshot).toEqual(original);
    },
  );

  it("does not skip a retired custom cron partition on a pristine state root", async () => {
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
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: sourceConfig,
      sourceConfig,
      parsed: {
        agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
        cron: { store: "/tmp/custom-cron/jobs.json" },
      },
      includedPaths: [],
      legacyIssues: [{ path: "cron.store", message: "cron.store is retired" }],
      warnings: [],
      issues: [{ path: "gateway.port", message: "invalid port" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      skipPristineCoreStateMigrations: true,
    });

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
      memory: {
        search: {
          store: {
            path: "/custom/memory-{agentId}.sqlite",
            vector: { enabled: false },
          },
        },
      },
      agents: {
        defaults: {},
        entries: { main: {} },
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: resolvedConfig,
      sourceConfig: resolvedConfig,
      parsed: parsedConfig,
      includedPaths,
      legacyIssues: [
        {
          path: "memory.search.store.path",
          message:
            "memory.search.store.path is legacy; memory indexes now live in each agent database.",
        },
      ],
      warnings: [],
      issues: [],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        cron: expect.objectContaining({ webhook: "https://example.invalid/cron-finished" }),
        memory: expect.objectContaining({
          search: expect.objectContaining({
            store: {
              vector: { enabled: false },
            },
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({}),
          entries: { main: {} },
        }),
      }),
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        memory: expect.objectContaining({
          search: expect.objectContaining({
            store: {
              vector: { enabled: false },
            },
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({}),
          entries: { main: {} },
        }),
      }),
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
      memory: {
        search: {
          store: {
            path: "/custom/memory-{agentId}.sqlite",
            vector: { enabled: false },
          },
        },
      },
      agents: {
        defaults: {},
        list: [{ id: "main" }],
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: resolvedConfig,
      sourceConfig: resolvedConfig,
      parsed: resolvedConfig,
      includedPaths: [],
      legacyIssues: [
        {
          path: "memory.search.store.path",
          message:
            "memory.search.store.path is legacy; memory indexes now live in each agent database.",
        },
      ],
      warnings: [],
      issues: [{ path: "gateway.port", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      doctorOnlyStateMigrations: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
      doctorOnlyStateMigrations: true,
    });
    expect(autoMigrateLegacyTaskStateSidecars).toHaveBeenCalledWith({ env: process.env });
    expect(note).toHaveBeenCalledWith("- plugin-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- task-imported", "Doctor changes");
  });

  it("runs config-independent state migration for invalid config", async () => {
    findDoctorLegacyConfigIssues.mockReturnValueOnce([
      { path: "cron.store", message: "cron.store is legacy." },
    ]);
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: { cron: { store: "/tmp/legacy-cron.json" } },
      sourceConfig: { cron: { store: "/tmp/legacy-cron.json" } },
      parsed: { cron: { store: "/tmp/legacy-cron.json" } },
      includedPaths: [],
      legacyIssues: [],
      warnings: [],
      issues: [{ path: "gateway", message: "invalid" }],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
    const migrationParams = autoMigrateLegacyState.mock.calls[0]?.[0] as
      | {
          cfg?: unknown;
          pluginDoctorConfig?: unknown;
          env?: NodeJS.ProcessEnv;
        }
      | undefined;
    expect(migrationParams?.cfg).not.toHaveProperty("cron.store");
    expect(migrationParams?.pluginDoctorConfig).toEqual({
      cron: { store: "/tmp/legacy-cron.json" },
    });
    expect(migrationParams?.env).toBe(process.env);
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ cron: { store: "/tmp/legacy-cron.json" } }),
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });
});
