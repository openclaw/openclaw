/** Ordered shared migration preparation and its frozen source endpoints. */
import path from "node:path";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  AgentDatabaseMigrationTarget,
  PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import type { PreparedLegacyStateMigrationStep } from "./state-migrations.plan.js";
import { migrateOrphanedSessionKeys } from "./state-migrations.session-store.js";
import {
  migrateLegacyProfileWorkspace,
  resolveLegacyProfileWorkspaceMigrationPaths,
  resolvePendingLegacyProfileWorkspaceMigrationPaths,
} from "./state-migrations.state-dir.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationInvocationPurpose,
  LegacyStateMigrationMode,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";

export function buildUnresolvedBlockedPreludeSteps(
  mode: LegacyStateMigrationMode,
  invocationPurpose: LegacyStateMigrationInvocationPurpose,
): LegacyStateMigrationStep[] {
  const ids = [
    ...(mode === "doctor" ? ["media-persistence"] : []),
    ...(invocationPurpose === "doctor" ? ["transcript-directives"] : []),
    ...(mode === "doctor"
      ? ["profile-workspace", "plugin-migration-preparation", "orphan-session-keys"]
      : []),
  ];
  return ids.map((id) => ({
    id,
    phase: "shared",
    source: [],
    target: [],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    run: () => ({ changes: [], warnings: [] }),
  }));
}

export function uniqueMigrationEndpoints(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): LegacyStateMigrationEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key =
      endpoint.kind === "owner" ? `owner\0${endpoint.id}` : `${endpoint.kind}\0${endpoint.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function createDeferredPluginSessionStoreRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  return endpoints.length > 0
    ? {
        code: "plugin-planning-deferred",
        message: "Plugin session migrations will be checked with the update.",
      }
    : undefined;
}

export function createConfigMigrationSources(
  configPath: string,
  includedPaths: readonly string[],
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [configPath, ...includedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: path.resolve(inputPath),
    })),
  );
}

export function inspectOrphanSessionStoreEndpoints(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginSessionStoreAgentIds: readonly string[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
}): { endpoints: LegacyStateMigrationEndpoint[]; warnings: string[] } {
  try {
    const paths = resolveAllAgentSessionStoreCandidateTargetsSync(params.config, {
      env: params.env,
      registeredDatabases: params.registeredDatabases,
    }).map((target) => target.storePath);
    for (const agentId of params.pluginSessionStoreAgentIds) {
      paths.push(
        resolveSessionStorePathCore(params.config.session?.store, {
          agentId,
          env: params.env,
        }),
      );
    }
    return {
      endpoints: uniqueMigrationEndpoints(
        paths
          .filter((storePath) => !storePath.endsWith(".sqlite"))
          .map((storePath) => ({ kind: "path" as const, path: storePath })),
      ),
      warnings: [],
    };
  } catch (error) {
    return {
      endpoints: [{ kind: "owner", id: "core:session-store-targets" }],
      warnings: [`Could not inspect session migration targets: ${String(error)}`],
    };
  }
}

export function buildLegacyStateMigrationPreludeSteps(params: {
  mode: LegacyStateMigrationMode;
  invocationPurpose: LegacyStateMigrationInvocationPurpose;
  config: OpenClawConfig;
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  agentDatabaseTargets: readonly { agentId: string; path: string }[];
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  orphanSessionStores?: ReturnType<typeof inspectOrphanSessionStoreEndpoints>;
  pluginSessionStoreAgentIds: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
  deferredPluginSessionStoreEndpoints?: readonly LegacyStateMigrationEndpoint[];
  readOnlyPlanning?: boolean;
  pluginPreparation?: LegacyStateMigrationStep;
}): LegacyStateMigrationStep[] {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDatabase: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath(stateEnv),
  };
  const configSources = createConfigMigrationSources(params.configPath, params.configIncludedPaths);
  const agentPersistence = uniqueMigrationEndpoints([
    stateDatabase,
    { kind: "path", path: path.join(params.stateDir, "agents") },
    ...params.agentDatabaseTargets.map(({ path: databasePath }): LegacyStateMigrationEndpoint => ({
      kind: "sqlite",
      path: databasePath,
    })),
  ]);
  const sharedStep = (
    id: string,
    source: LegacyStateMigrationEndpoint[],
    target: LegacyStateMigrationEndpoint[],
    run: LegacyStateMigrationStep["run"],
    refusal?: PreparedLegacyStateMigrationStep["refusal"],
    requiredness: PreparedLegacyStateMigrationStep["requiredness"] = "conditional",
  ): LegacyStateMigrationStep => ({
    id,
    phase: "shared",
    source,
    target,
    requiredness,
    reversibility: "checkpoint-required",
    collectNotices: id === "profile-workspace",
    ...(refusal ? { refusal } : {}),
    run,
  });
  const agentMigrationOptions = {
    configuredAgentDatabaseTargets: params.agentDatabaseTargets,
    env: stateEnv,
    preparedDiscovery: params.agentDatabaseMigrationDiscovery,
  };
  let preparedTargets: readonly AgentDatabaseMigrationTarget[] | undefined;
  const steps: LegacyStateMigrationStep[] = [];
  if (params.mode === "doctor") {
    steps.push(
      sharedStep("media-persistence", agentPersistence, agentPersistence, () =>
        migrateLegacyMediaPersistence({
          ...agentMigrationOptions,
          onPreparedTargets: (targets) => {
            preparedTargets = targets;
          },
        }),
      ),
    );
  }
  if (params.invocationPurpose === "doctor") {
    steps.push(
      sharedStep("transcript-directives", agentPersistence, agentPersistence, async () => {
        const { migrateHistoricalTranscriptDirectives } =
          await import("./state-migrations.transcript-directives.js");
        return await migrateHistoricalTranscriptDirectives({
          ...agentMigrationOptions,
          preparedTargets,
        });
      }),
    );
  }
  if (params.mode !== "doctor") {
    return steps;
  }
  const profileParams = { config: params.config, env: params.env, homedir: params.homedir };
  const profileWorkspace = (
    params.readOnlyPlanning
      ? resolveLegacyProfileWorkspaceMigrationPaths
      : resolvePendingLegacyProfileWorkspaceMigrationPaths
  )(profileParams);
  const profileRefusal =
    profileWorkspace && params.readOnlyPlanning
      ? {
          code: "profile-workspace-snapshot-deferred",
          message:
            "Profile workspace migration is outside the bound state root and requires a separately bound snapshot.",
        }
      : undefined;
  steps.push(
    sharedStep(
      "profile-workspace",
      profileWorkspace ? [{ kind: "path", path: profileWorkspace.source }] : [],
      profileWorkspace ? [{ kind: "path", path: profileWorkspace.target }] : [],
      () => migrateLegacyProfileWorkspace(profileParams),
      profileRefusal,
      profileWorkspace ? "conditional" : "not-required",
    ),
  );
  if (params.pluginPreparation) {
    steps.push(params.pluginPreparation);
  }
  const orphanSessionStores = params.orphanSessionStores;
  if (!orphanSessionStores) {
    // Early failures still close this stable step; its sources are prepared after prerequisites.
    steps.push(
      ...buildUnresolvedBlockedPreludeSteps(params.mode, params.invocationPurpose).filter(
        (step) => step.id === "orphan-session-keys",
      ),
    );
    return steps;
  }
  const deferredPluginOwners = params.deferredPluginSessionStoreEndpoints ?? [];
  const orphanTargets = uniqueMigrationEndpoints([
    ...orphanSessionStores.endpoints,
    ...deferredPluginOwners,
  ]);
  const pluginRefusal =
    orphanSessionStores.warnings.length > 0
      ? {
          code: "session-target-discovery-failed",
          message: orphanSessionStores.warnings.join("\n"),
        }
      : createDeferredPluginSessionStoreRefusal(deferredPluginOwners);
  steps.push(
    sharedStep(
      "orphan-session-keys",
      uniqueMigrationEndpoints([...configSources, ...orphanTargets]),
      orphanTargets,
      () =>
        orphanSessionStores.warnings.length > 0
          ? { changes: [], warnings: orphanSessionStores.warnings }
          : migrateOrphanedSessionKeys({
              cfg: params.config,
              env: stateEnv,
              additionalAgentIds: params.pluginSessionStoreAgentIds,
              legacySessionSurfaces: params.legacySessionSurfaces,
            }),
      pluginRefusal,
    ),
  );
  return steps;
}
