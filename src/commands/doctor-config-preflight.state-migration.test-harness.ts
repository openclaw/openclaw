import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { LegacyConfigIssue } from "../config/types.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  makePreflightConfigSnapshot,
  makeStartupConvergenceResult,
  makeStateMigrationResult,
  type StartupConvergenceResult,
  type StartupSmokeFailure,
  type StateMigrationResult,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

const handoffDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    handoffResolver?.mockRestore();
    cleanup();
  }),
);
let handoffResolver: MockInstance<typeof tempRoot.resolvePreferredOpenClawTmpDir> | undefined;
beforeEach(() => {
  const root = path.join(handoffDirs.make("openclaw-preflight-handoff-"), "private");
  mkdirSync(root, { mode: 0o700 });
  handoffResolver = vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
    path.join(root, "managed-update-handoffs.sqlite"),
  );
});

const autoMigrateLegacyStateDir = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => makeStateMigrationResult([], false)),
);
const autoMigrateLegacyState = vi.hoisted(() =>
  vi.fn(
    async (_params?: {
      onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
    }): Promise<StateMigrationResult> => makeStateMigrationResult(["imported"]),
  ),
);
const prepareLegacyStateDatabaseSchema = vi.hoisted(() =>
  vi.fn<typeof import("../infra/state-migrations.doctor.js").prepareLegacyStateDatabaseSchema>(
    async () => ({
      id: "state-schema",
      phase: "shared",
      source: [],
      target: [],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome: "skipped",
      changes: [],
      warnings: [],
    }),
  ),
);
const prepareDoctorDatabasePreflight = vi.hoisted(() =>
  vi.fn<typeof import("./doctor-database-preflight.js").prepareDoctorDatabasePreflight>(
    async () => ({ incompatible: [], indeterminate: [] }),
  ),
);
const doctorMaintenanceRelease = vi.hoisted(() => vi.fn(async () => {}));
const beginDoctorMaintenance = vi.hoisted(() =>
  vi.fn<typeof import("./doctor-maintenance.js").beginDoctorMaintenance>(async () => ({
    run: <T>(operation: () => T): T => operation(),
    releaseState: vi.fn(async () => {}),
    release: doctorMaintenanceRelease,
    finish: vi.fn(async () => {}),
  })),
);
const noteSessionTranscriptHealth = vi.hoisted(() =>
  vi.fn<typeof import("./doctor-session-transcripts.js").noteSessionTranscriptHealth>(
    async () => undefined,
  ),
);
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() =>
  vi.fn(async (): Promise<StateMigrationResult> => makeStateMigrationResult(["plugin-imported"])),
);
const migrateLegacyConfigMachineState = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      changes: string[];
      warnings: string[];
      codexRuntimePolicyTargets?: Array<{ modelRef: string }>;
    }> => ({ changes: ["cron-imported"], warnings: [] }),
  ),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async (): Promise<{ targets: Array<{ modelRef: string }>; warnings: string[] }> => ({
    targets: [],
    warnings: [],
  })),
);
const readMigrationCheckpointStatus = vi.hoisted(() =>
  vi.fn<() => "stale" | "state-current" | "startup-current">(() => "startup-current"),
);
const startupMigrationLeaseHeartbeat = vi.hoisted(() => vi.fn());
const startupMigrationLeaseRelease = vi.hoisted(() => vi.fn());
const startupMigrationLeaseAssertOwnedInTransaction = vi.hoisted(() => vi.fn());
const startupMigrationLease = vi.hoisted(() => ({
  assertOwnedInTransaction: startupMigrationLeaseAssertOwnedInTransaction,
  heartbeat: startupMigrationLeaseHeartbeat,
  owner: "startup-test-owner",
  release: startupMigrationLeaseRelease,
}));
const acquireStartupMigrationLeaseWithWait = vi.hoisted(() =>
  vi.fn(async (_params: { env: NodeJS.ProcessEnv }) => startupMigrationLease),
);
const recordSuccessfulStateMigrations = vi.hoisted(() => vi.fn());
const recordSuccessfulStartupMigrations = vi.hoisted(() => vi.fn());
const runPostCorePluginConvergence = vi.hoisted(() =>
  vi.fn(async (): Promise<StartupConvergenceResult> => ({
    changes: [],
    notices: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
  })),
);
const runActivePluginPayloadSmokeCheck = vi.hoisted(() =>
  vi.fn(async (): Promise<{ checked: string[]; failures: StartupSmokeFailure[] }> => ({
    checked: [],
    failures: [],
  })),
);
const planStartupPluginConvergence = vi.hoisted(() =>
  vi.fn(async () => ({ required: true, installRecords: {} })),
);
const planPristineStartupStateMigrations = vi.hoisted(() =>
  vi.fn(() => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  })),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async (): Promise<ReturnType<typeof makePreflightConfigSnapshot>> => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } },
    sourceConfig: { gateway: { mode: "local", port: 19091 } },
    parsed: { gateway: { mode: "local", port: 19091 } },
    legacyIssues: [],
    warnings: [],
    issues: [],
  })),
);
const pluginMigrationFingerprint = vi.hoisted(() =>
  vi.fn((_allowCurrentPluginMetadata?: boolean) => "plugin-migrations"),
);
type ConfigSnapshotWithPluginMetadataFixture = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  pluginMetadataSnapshot?: Pick<
    PluginMetadataSnapshot,
    "configFingerprint" | "policyHash" | "plugins"
  >;
};
const readConfigFileSnapshotWithPluginMetadata = vi.hoisted(() =>
  vi.fn<
    (options?: {
      allowCurrentPluginMetadata?: boolean;
    }) => Promise<ConfigSnapshotWithPluginMetadataFixture>
  >(async (options) => {
    const snapshot = await readConfigFileSnapshot();
    return {
      snapshot,
      pluginMetadataSnapshot: {
        plugins: [],
        configFingerprint: pluginMigrationFingerprint(options?.allowCurrentPluginMetadata),
        policyHash: resolveInstalledPluginIndexPolicyHash(snapshot.sourceConfig),
      },
    };
  }),
);
const findDoctorLegacyConfigIssues = vi.hoisted(() => vi.fn((): LegacyConfigIssue[] => []));
const addDoctorLegacyIssues = vi.hoisted(() => vi.fn(<T>(snapshot: T): T => snapshot));
const runWithPluginMetadataSnapshot = vi.hoisted(() =>
  vi.fn((_scope: unknown, run: () => unknown) => run()),
);
const note = vi.hoisted(() => vi.fn());
const pendingPluginMigrations = vi.hoisted(() => vi.fn((): DeferredPluginMigration[] => []));
const recordDeferredPluginMigrations = vi.hoisted(() =>
  vi.fn<typeof import("../infra/deferred-plugin-migrations.js").recordDeferredPluginMigrations>(
    ({ pending }) => pending,
  ),
);
const inspectPluginMigrationAvailability = vi.hoisted(() =>
  vi.fn<
    typeof import("./doctor/shared/plugin-migration-availability.js").inspectPluginMigrationAvailability
  >(async () => ({
    pending: [],
    requiredPluginIds: [],
    inspectionRequiredPluginIds: [],
    statelessPluginIds: [],
    runtimePluginAliases: [],
  })),
);

vi.mock("../infra/deferred-plugin-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrations: pendingPluginMigrations,
  recordDeferredPluginMigrations,
}));
vi.mock("./doctor/shared/plugin-migration-availability.js", () => ({
  inspectPluginMigrationAvailability,
}));

vi.mock("../infra/state-migrations.doctor.js", () => ({
  autoMigrateLegacyState,
  prepareLegacyStateDatabaseSchema,
}));

vi.mock("./doctor-database-preflight.js", () => ({ prepareDoctorDatabasePreflight }));
vi.mock("./doctor-maintenance.js", () => ({ beginDoctorMaintenance }));
vi.mock("./doctor-session-transcripts.js", () => ({ noteSessionTranscriptHealth }));

vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir,
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

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS: 60_000,
  acquireStartupMigrationLeaseWithWait,
  inspectStartupMigrationCheckpointWithLease: async (params: {
    env: NodeJS.ProcessEnv;
    stateMigrations: boolean;
    startupMigrations: boolean;
    forceLease: boolean;
  }) => {
    const status =
      params.stateMigrations || params.startupMigrations
        ? readMigrationCheckpointStatus()
        : "stale";
    const required =
      params.forceLease ||
      (params.stateMigrations && status === "stale") ||
      (params.startupMigrations && status !== "startup-current");
    return {
      status,
      lease: required ? await acquireStartupMigrationLeaseWithWait(params) : undefined,
    };
  },
  readMigrationCheckpointStatus,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
}));

vi.mock("../plugins/active-payload-verification.js", () => ({
  runActivePluginPayloadSmokeCheck,
}));

vi.mock("./doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence,
}));

vi.mock("./doctor/shared/startup-plugin-convergence-plan.js", () => ({
  planStartupPluginConvergence,
}));

vi.mock("./doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupStateMigrations,
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  recoverConfigFromJsonRootSuffix: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
}));

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues,
  findDoctorLegacyConfigIssues,
}));

vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", () => ({
  createDoctorPluginMetadataSnapshotScope: (params: {
    getBaseSnapshot: () => PluginMetadataSnapshot | undefined;
  }) => ({
    run: (_scope: unknown, operation: () => unknown) =>
      runWithPluginMetadataSnapshot(params.getBaseSnapshot(), operation),
    invalidate: vi.fn(),
  }),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

export const preflightStateMigrationMocks = {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  prepareLegacyStateDatabaseSchema,
  prepareDoctorDatabasePreflight,
  beginDoctorMaintenance,
  doctorMaintenanceRelease,
  noteSessionTranscriptHealth,
  autoMigrateLegacyPluginDoctorState,
  repairLegacyCronStoreWithoutPrompt,
  collectCronCodexRuntimePolicyTargetsReadOnly,
  readMigrationCheckpointStatus,
  startupMigrationLeaseHeartbeat,
  startupMigrationLeaseRelease,
  startupMigrationLease,
  acquireStartupMigrationLeaseWithWait,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
  runPostCorePluginConvergence,
  runActivePluginPayloadSmokeCheck,
  planStartupPluginConvergence,
  planPristineStartupStateMigrations,
  readConfigFileSnapshot,
  pluginMigrationFingerprint,
  readConfigFileSnapshotWithPluginMetadata,
  runWithPluginMetadataSnapshot,
  note,
  recordDeferredPluginMigrations,
};

export function resetStateMigrationPreflightMocks(): void {
  vi.clearAllMocks();
  prepareLegacyStateDatabaseSchema.mockReset();
  prepareDoctorDatabasePreflight.mockReset();
  beginDoctorMaintenance.mockReset();
  doctorMaintenanceRelease.mockReset();
  noteSessionTranscriptHealth.mockReset();
  pendingPluginMigrations.mockReset().mockReturnValue([]);
  inspectPluginMigrationAvailability.mockReset().mockResolvedValue({
    pending: [],
    requiredPluginIds: [],
    inspectionRequiredPluginIds: [],
    statelessPluginIds: [],
    runtimePluginAliases: [],
  });
  acquireStartupMigrationLeaseWithWait.mockResolvedValue(startupMigrationLease);
  pluginMigrationFingerprint.mockReset();
  pluginMigrationFingerprint.mockReturnValue("plugin-migrations");
  findDoctorLegacyConfigIssues.mockReset();
  findDoctorLegacyConfigIssues.mockReturnValue([]);
  setActiveDegradedPlugins([]);
  readMigrationCheckpointStatus.mockReset();
  readMigrationCheckpointStatus.mockReturnValue("startup-current");
  runPostCorePluginConvergence.mockResolvedValue(makeStartupConvergenceResult());
  runActivePluginPayloadSmokeCheck.mockReset().mockResolvedValue({ checked: [], failures: [] });
  planStartupPluginConvergence.mockResolvedValue({ required: true, installRecords: {} });
  planPristineStartupStateMigrations.mockReturnValue({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  });
  autoMigrateLegacyStateDir.mockResolvedValue(makeStateMigrationResult([], false));
  autoMigrateLegacyState.mockResolvedValue(makeStateMigrationResult(["imported"]));
  autoMigrateLegacyPluginDoctorState.mockResolvedValue(
    makeStateMigrationResult(["plugin-imported"]),
  );
  repairLegacyCronStoreWithoutPrompt.mockResolvedValue({
    changes: ["cron-imported"],
    warnings: [],
  });
  collectCronCodexRuntimePolicyTargetsReadOnly.mockReset();
  collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValue({ targets: [], warnings: [] });
}
