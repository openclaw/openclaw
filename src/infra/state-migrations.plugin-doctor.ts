import os from "node:os";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listPluginDoctorStateMigrationEntries,
  PluginDoctorStateMigrationDeclarationError,
  type PluginDoctorStateMigration,
  type PluginDoctorStateMigrationDetection,
  type PluginDoctorStateMigrationInventory,
} from "../plugins/doctor-contract-registry.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import { prepareOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { formatStartupMigrationFailure } from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import { autoMigrateLegacyStateDir } from "./state-migrations.state-dir.js";
import type {
  DetectedPluginDoctorStateMigrationPlan,
  LegacyStateDetection,
  MigrationLogger,
  MigrationMessages,
  PlannedPluginDoctorAction,
  PluginDoctorRepairAuthority,
} from "./state-migrations.types.js";

type PluginDoctorInput = Omit<
  Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
  "context"
>;

const PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS = 250;
const PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS = 25;

type PluginDoctorPlanCollection = {
  plans: DetectedPluginDoctorStateMigrationPlan[];
  inspectedPluginIds: Set<string>;
  otherPhasePluginIds: Set<string>;
  requiredPluginIds: Set<string>;
  statelessPluginIds: Set<string>;
};

function pluginInspectionFacts(
  collection: PluginDoctorPlanCollection,
): Pick<MigrationMessages, "requiredPluginIds" | "statelessPluginIds"> {
  return {
    ...(collection.requiredPluginIds.size > 0
      ? { requiredPluginIds: [...collection.requiredPluginIds] }
      : {}),
    ...(collection.statelessPluginIds.size > 0
      ? { statelessPluginIds: [...collection.statelessPluginIds] }
      : {}),
  };
}

function completedPluginInspection(
  collection: PluginDoctorPlanCollection,
  migrated: MigrationMessages,
  excludedPluginIds: ReadonlySet<string> = collection.otherPhasePluginIds,
): Pick<MigrationMessages, "completedPluginIds"> {
  const pendingIds = new Set(collection.plans.map((plan) => plan.pluginId));
  const migratedIds = new Set(migrated.completedPluginIds);
  const completedPluginIds = [...collection.inspectedPluginIds].filter(
    (pluginId) =>
      !excludedPluginIds.has(pluginId) && (!pendingIds.has(pluginId) || migratedIds.has(pluginId)),
  );
  return completedPluginIds.length > 0 ? { completedPluginIds } : {};
}

function validatePluginDoctorPlanOrder(params: {
  actions: readonly PlannedPluginDoctorAction[];
  plannedActions: readonly PlannedPluginDoctorAction[];
}): string | undefined {
  const uniqueActions = new Set(
    params.actions.map((action) => JSON.stringify([action.pluginId, action.id])),
  );
  if (
    uniqueActions.size !== params.actions.length ||
    params.actions.length !== params.plannedActions.length ||
    params.actions.some((action, index) => {
      const planned = params.plannedActions[index];
      return action.pluginId !== planned?.pluginId || action.id !== planned?.id;
    })
  ) {
    return `Refused plugin migrations that do not match the immutable action order: ${params.actions
      .map((action) => `${action.pluginId}:${action.id}`)
      .join(", ")}.`;
  }
  return undefined;
}

export async function collectPluginDoctorStateMigrationPlans(
  input: PluginDoctorInput,
  params: {
    includeDoctorOnly?: boolean;
    phase?: PluginDoctorStateMigration["phase"];
    repairAuthority?: PluginDoctorRepairAuthority;
    warnings?: string[];
    plannedActions?: readonly PlannedPluginDoctorAction[];
    inventory?: PluginDoctorStateMigrationInventory;
    validateDeclarations?: boolean;
  },
): Promise<PluginDoctorPlanCollection> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  const inspectedPluginIds = new Set<string>();
  const otherPhasePluginIds = new Set<string>();
  const requiredPluginIds = new Set<string>();
  const statelessPluginIds = new Set<string>();
  const collected = {
    plans,
    inspectedPluginIds,
    otherPhasePluginIds,
    requiredPluginIds,
    statelessPluginIds,
  };
  const { config, env } = input;
  let entries: ReturnType<typeof listPluginDoctorStateMigrationEntries>;
  try {
    entries = listPluginDoctorStateMigrationEntries({
      config,
      env,
      inventory: params.inventory,
      validateDeclarations: params.validateDeclarations,
      onInspectedPlugin: (pluginId) => inspectedPluginIds.add(pluginId),
      onInspectedStatelessPlugin: (pluginId) => statelessPluginIds.add(pluginId),
    });
  } catch (error) {
    if (!(error instanceof PluginDoctorStateMigrationDeclarationError)) {
      throw error;
    }
    params.warnings?.push(error.message);
    inspectedPluginIds.clear();
    return collected;
  }
  for (const entry of entries) {
    requiredPluginIds.add(entry.pluginId);
    inspectedPluginIds.add(entry.pluginId);
    if (entry.migration.phase !== params.phase) {
      otherPhasePluginIds.add(entry.pluginId);
    }
  }
  for (const entry of entries) {
    if (entry.migration.doctorOnly === true && params.includeDoctorOnly !== true) {
      inspectedPluginIds.delete(entry.pluginId);
    }
  }
  entries = entries.filter(
    ({ migration }) =>
      migration.phase === params.phase &&
      (migration.doctorOnly !== true || params.includeDoctorOnly === true),
  );
  // Validate all exports before detection removes completed actions. Otherwise a
  // reordered or missing export can hide behind the currently pending subset.
  if (params.plannedActions) {
    const refusal = validatePluginDoctorPlanOrder({
      actions: entries.map(({ pluginId, migration }) => ({ pluginId, id: migration.id })),
      plannedActions: params.plannedActions,
    });
    if (refusal) {
      params.warnings?.push(refusal);
      inspectedPluginIds.clear();
      return collected;
    }
  }
  for (const entry of entries) {
    let detected: PluginDoctorStateMigrationDetection | null;
    try {
      detected = await entry.migration.detectLegacyState({
        ...input,
        serviceWorkspaceDir:
          tryResolveConfiguredAgentWorkspaceDir(config, env) ??
          resolveDefaultAgentWorkspaceDir(env),
        context: createPluginDoctorStateMigrationContext({
          pluginId: entry.pluginId,
          env,
          config,
          repairAuthority: params.repairAuthority,
          // Detection runs before exclusive state ownership, so it is handed
          // inspection-only ingress access and no mutation gate. Untrusted owners get
          // no ingress lane at all: Doctor must not widen the runtime's durable-store
          // trust gate.
          // `?? true` keeps older or hand-built hosts working; a real registry record
          // always carries the decision explicitly.
          ...((entry.trustedForDurableStores ?? true)
            ? {
                channelIngress: {
                  channelIds: entry.channelIds ?? [],
                  stateDir: input.stateDir,
                },
              }
            : {}),
        }),
      });
    } catch (err) {
      inspectedPluginIds.delete(entry.pluginId);
      params.warnings?.push(`Failed detecting ${entry.migration.label}: ${String(err)}`);
      continue;
    }
    if (detected?.preview.length) {
      plans.push({
        pluginId: entry.pluginId,
        channelIds: entry.channelIds,
        trustedForDurableStores: entry.trustedForDurableStores,
        migration: entry.migration,
        preview: detected.preview,
      });
    }
  }
  return collected;
}

export async function runPluginDoctorStateMigrationPlans(params: {
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  plannedActions?: readonly PlannedPluginDoctorAction[];
  inventory?: PluginDoctorStateMigrationInventory;
}): Promise<MigrationMessages> {
  const input: PluginDoctorInput = {
    config: params.config,
    env: params.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
  };
  const warnings: string[] = [];
  const collected = await collectPluginDoctorStateMigrationPlans(input, {
    includeDoctorOnly: params.detected.doctorOnlyStateMigrations,
    warnings,
    plannedActions: params.plannedActions,
    inventory: params.inventory,
  });
  const hasDetectorFailure = warnings.length > 0;
  const migrated = await migratePluginDoctorStatePlans(input, collected.plans);
  return {
    ...migrated,
    completedPluginIds: undefined,
    ...completedPluginInspection(collected, migrated),
    ...pluginInspectionFacts(collected),
    warnings: [...warnings, ...migrated.warnings],
    ...(hasDetectorFailure ? { warningDisposition: undefined } : {}),
  };
}

async function migratePluginDoctorStatePlans(
  input: PluginDoctorInput,
  plans: readonly DetectedPluginDoctorStateMigrationPlan[],
  repairAuthority?: PluginDoctorRepairAuthority,
): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const completedPluginIds = new Set(plans.map((plan) => plan.pluginId));
  let hasRefusal = false;
  if (plans.length === 0) {
    return { changes, warnings };
  }

  // Mutable ingress access lives and dies with this call. Handles a migration keeps
  // past its own return re-check this gate and fail rather than writing outside the
  // section that owns the state.
  let ingressMutationActive = false;
  const assertIngressMutationCurrent = () => {
    if (!ingressMutationActive) {
      throw new Error("Plugin Doctor ingress queue access has expired.");
    }
    repairAuthority?.assertCurrent();
  };

  const migrate = async () => {
    ingressMutationActive = true;
    try {
      return await migrateWithIngressAuthority();
    } finally {
      ingressMutationActive = false;
    }
  };

  const migrateWithIngressAuthority = async () => {
    for (const plan of plans) {
      try {
        repairAuthority?.assertCurrent();
        const result = await plan.migration.migrateLegacyState({
          ...input,
          serviceWorkspaceDir:
            tryResolveConfiguredAgentWorkspaceDir(input.config, input.env) ??
            resolveDefaultAgentWorkspaceDir(input.env),
          context: createPluginDoctorStateMigrationContext({
            pluginId: plan.pluginId,
            env: input.env,
            config: input.config,
            repairAuthority,
            ...((plan.trustedForDurableStores ?? true)
              ? {
                  channelIngress: {
                    channelIds: plan.channelIds ?? [],
                    stateDir: input.stateDir,
                    mutation: { assertCurrent: assertIngressMutationCurrent },
                  },
                }
              : {}),
          }),
        });
        repairAuthority?.assertCurrent();
        changes.push(...result.changes);
        warnings.push(...result.warnings);
        if (result.warnings.length > 0) {
          completedPluginIds.delete(plan.pluginId);
        }
        if (result.warnings.length > 0 && result.warningDisposition !== "recoverable") {
          hasRefusal = true;
        }
        notices.push(...(result.notices ?? []));
      } catch (err) {
        completedPluginIds.delete(plan.pluginId);
        hasRefusal = true;
        warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
      }
    }
    return {
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
      ...(completedPluginIds.size > 0 ? { completedPluginIds: [...completedPluginIds] } : {}),
      ...(warnings.length > 0 && !hasRefusal ? { warningDisposition: "recoverable" as const } : {}),
    };
  };
  // Session repair already holds the Gateway lock and cross-process database fences.
  if (repairAuthority) {
    return migrate();
  }

  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env: { ...input.env, OPENCLAW_STATE_DIR: input.stateDir },
      pollIntervalMs: PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      changes,
      warnings: [
        `Skipped plugin doctor state migrations because exclusive state ownership is unavailable: ${String(error)}`,
      ],
    };
  }
  if (!lock) {
    return {
      changes,
      warnings: [
        "Skipped plugin doctor state migrations because exclusive state ownership is unavailable",
      ],
    };
  }

  try {
    // Plugin migrations may claim retired files after verified import. Keep the
    // predecessor Gateway excluded for the full read, import, and archive window.
    return await lock.run(migrate);
  } finally {
    await lock.release();
  }
}

/** Detect after canonical inspection; destructive repair also requires offline maintenance ownership. */
export async function runPostSessionPluginDoctorStateRepairs(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  maintenanceAuthority?: { assertCurrent(): void };
  plannedActions?: readonly PlannedPluginDoctorAction[];
  inventory?: PluginDoctorStateMigrationInventory;
  beforeCompletion?: (
    completedPluginIds: readonly string[],
    assertCurrent: () => void,
  ) => Promise<void>;
}): Promise<MigrationMessages> {
  const stateDir = resolveStateDir(params.env);
  const input: PluginDoctorInput = {
    config: params.config,
    env: params.env,
    stateDir,
    oauthDir: resolveOAuthDir(params.env, stateDir),
  };
  const run = async (repairAuthority?: PluginDoctorRepairAuthority): Promise<MigrationMessages> => {
    const warnings: string[] = [];
    repairAuthority?.assertCurrent();
    const collected = await collectPluginDoctorStateMigrationPlans(input, {
      includeDoctorOnly: true,
      phase: "after-session-repair",
      repairAuthority,
      warnings,
      plannedActions: params.plannedActions,
      inventory: params.inventory,
    });
    if (!repairAuthority) {
      return {
        changes: [],
        warnings: [
          ...warnings,
          ...collected.plans.flatMap((plan) => plan.preview),
          ...(collected.plans.length
            ? ['Run "openclaw doctor --fix" to repair plugin session ownership.']
            : []),
        ],
      };
    }
    const result = await migratePluginDoctorStatePlans(input, collected.plans, repairAuthority);
    // The later phase cannot certify an earlier action that still reports pending work.
    const earlier = await collectPluginDoctorStateMigrationPlans(input, {
      includeDoctorOnly: true,
      inventory: params.inventory,
      repairAuthority,
      warnings,
    });
    const unfinishedEarlierIds = new Set([
      ...earlier.plans.map((plan) => plan.pluginId),
      ...[...collected.inspectedPluginIds].filter(
        (pluginId) => !earlier.inspectedPluginIds.has(pluginId),
      ),
    ]);
    return {
      ...result,
      completedPluginIds: undefined,
      ...completedPluginInspection(collected, result, unfinishedEarlierIds),
      ...pluginInspectionFacts(collected),
      warnings: [...warnings, ...result.warnings],
      ...(warnings.length > 0 ? { warningDisposition: undefined } : {}),
    };
  };
  const maintenance = params.maintenanceAuthority;
  if (!maintenance) {
    return run();
  }
  maintenance.assertCurrent();
  const {
    assertDeferredPluginMigrationsCurrent,
    readDeferredPluginMigrations,
    recordDeferredPluginMigrations,
  } = await import("./deferred-plugin-migrations.js");
  maintenance.assertCurrent();
  const expectedPending = readDeferredPluginMigrations({ env: params.env });
  const assertCompletionCurrent = () => {
    maintenance.assertCurrent();
    assertDeferredPluginMigrationsCurrent({ env: params.env, expectedPending });
  };
  let completed: MigrationMessages = { changes: [], warnings: [] };
  try {
    const result = await withAgentDatabaseMaintenanceLease(
      { env: params.env },
      async (agentLease) =>
        withPluginLifecycleLease({ env: params.env, waitMs: 5_000 }, async (pluginLease) => {
          let active = true;
          const assertCurrent = () => {
            if (!active) {
              throw new Error("Plugin Doctor repair authority has expired.");
            }
            maintenance.assertCurrent();
          };
          const authority: PluginDoctorRepairAuthority = {
            assertCurrent() {
              assertCurrent();
              agentLease.assertOwned();
              pluginLease.assertOwned();
            },
            assertOwnedInTransaction(database) {
              assertCurrent();
              agentLease.assertOwnedInTransaction(database);
              pluginLease.assertOwnedInTransaction(database);
            },
          };
          try {
            // Lease settlement can reject after the callback's mutations committed.
            // Retain those facts without treating a failed settlement as success.
            completed = await run(authority);
            return completed;
          } finally {
            active = false;
          }
        }),
    );
    if (result.completedPluginIds?.length) {
      assertCompletionCurrent();
      await params.beforeCompletion?.(result.completedPluginIds, assertCompletionCurrent);
      assertCompletionCurrent();
      recordDeferredPluginMigrations({
        env: params.env,
        pending: [],
        resolvedPluginIds: result.completedPluginIds,
        expectedPending,
      });
    }
    return result;
  } catch (error) {
    return {
      ...completed,
      completedPluginIds: undefined,
      warnings: [...completed.warnings, `Plugin session repair did not settle: ${String(error)}.`],
      warningDisposition: undefined,
    };
  }
}

export async function autoMigrateLegacyPluginDoctorState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  doctorOnlyStateMigrations?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
  completedPluginIds?: readonly string[];
  requiredPluginIds?: readonly string[];
  statelessPluginIds?: readonly string[];
}> {
  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const stateSchema = await prepareOpenClawStateDatabaseSchema(
    { env: { ...env, OPENCLAW_STATE_DIR: stateDir } },
    params.doctorOnlyStateMigrations === true ? "doctor" : "automatic",
  );
  const changes = [...stateDirResult.changes, ...stateSchema.changes];
  const warnings = [...stateDirResult.warnings, ...stateSchema.warnings];
  const notices = [...(stateDirResult.notices ?? [])];
  if (stateSchema.warnings.length > 0 && params.doctorOnlyStateMigrations !== true) {
    throw new Error(formatStartupMigrationFailure(stateSchema.warnings));
  }
  const input: PluginDoctorInput = { config: params.config, env, stateDir, oauthDir };
  const collected =
    stateSchema.warnings.length > 0
      ? {
          plans: [],
          inspectedPluginIds: new Set<string>(),
          otherPhasePluginIds: new Set<string>(),
          requiredPluginIds: new Set<string>(),
          statelessPluginIds: new Set<string>(),
        }
      : await collectPluginDoctorStateMigrationPlans(input, {
          includeDoctorOnly: params.doctorOnlyStateMigrations === true,
          warnings,
        });
  const migrated = await migratePluginDoctorStatePlans(input, collected.plans);
  changes.push(...migrated.changes);
  warnings.push(...migrated.warnings);
  notices.push(...(migrated.notices ?? []));
  return {
    migrated:
      stateDirResult.migrated || stateSchema.changes.length > 0 || collected.plans.length > 0,
    skipped: false,
    changes,
    warnings,
    ...completedPluginInspection(collected, migrated),
    ...pluginInspectionFacts(collected),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
