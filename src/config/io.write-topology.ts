import { isDeepStrictEqual } from "node:util";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  LEGACY_AGENT_ROSTER_RULES,
  retireLegacyAgentDefaultMarkers,
} from "../commands/doctor/shared/legacy-config-migrations.runtime.entries.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { pinSurvivorWorkspaceForRosterCollapse } from "./agent-workspace-roster-transition.js";
import { getConfigValueAtPath, setConfigValueAtPath } from "./config-paths.js";
import { restoreEnvVarRefsFromResolved } from "./env-preserve.js";
import { prepareAuthInheritanceOwnerForWrite } from "./io.auth-inheritance-owner.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";
import { coerceConfig } from "./io.read-helpers.js";
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import type {
  ConfigWriteOptions,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { prepareConfigWriteValues } from "./io.write-prepare.js";
import { findLegacyConfigRuleIssues } from "./legacy.js";
import { resolveLegacyAgentRosterOwner } from "./legacy.roster.js";
import type { OpenClawConfig } from "./types.js";
import { materializeLegacyAgentOwnershipForActiveChannelsResultAsync } from "./validation.js";

function cloneConfigPathParents(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  path: readonly string[],
): void {
  let sourceCursor: unknown = source;
  let targetCursor = target;
  for (const key of path.slice(0, -1)) {
    const sourceChild = isRecord(sourceCursor) ? sourceCursor[key] : undefined;
    const targetChild = targetCursor[key];
    if (targetChild === sourceChild) {
      const clone = isRecord(sourceChild) ? { ...sourceChild } : {};
      targetCursor[key] = clone;
      targetCursor = clone;
    } else if (isRecord(targetChild)) {
      targetCursor = targetChild;
    } else {
      const clone: Record<string, unknown> = {};
      targetCursor[key] = clone;
      targetCursor = clone;
    }
    sourceCursor = sourceChild;
  }
}

// Validation and commits share ownership preparation. The committing writer owns
// cron safety rechecks, runtime refresh, and persistence; Doctor owns cron repair.
export async function prepareConfigWriteTopology(
  params: ReadConfigFileSnapshotWithPluginMetadataResult & {
    nextConfig: OpenClawConfig;
    options: Pick<
      ConfigWriteOptions,
      | "explicitSetPaths"
      | "explicitSetValueSource"
      | "persistCanonicalAgentRoster"
      | "expectedConfigPath"
      | "envSnapshotForRestore"
    >;
    unsetPaths: readonly (readonly string[])[];
    env: NodeJS.ProcessEnv;
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    homedir?: () => string;
  },
) {
  const { snapshot, options, unsetPaths, env, homedir, pluginMetadataSnapshot } = params;
  const values = prepareConfigWriteValues({
    snapshot,
    nextConfig: params.nextConfig,
    writeOptions: options,
    env,
    lowerPrecedenceEnv: params.lowerPrecedenceEnv,
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetValueSource,
  });
  const sourceRosterIssues = findLegacyConfigRuleIssues(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
    LEGACY_AGENT_ROSTER_RULES,
  );
  // Adapt newly submitted aliases; persisted markers must keep their provenance until Doctor repairs them.
  const retiredMarkers =
    sourceRosterIssues.length === 0
      ? retireLegacyAgentDefaultMarkers(values.resolvedConfig)
      : undefined;
  let nextConfig = retiredMarkers?.config ?? values.resolvedConfig;
  const retainedLegacyDefaultAgentId = resolveLegacyAgentRosterOwner(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.parsed,
  );
  const previousEntries = listAgentEntries(snapshot.config);
  const nextEntries = listAgentEntries(nextConfig);
  const nextAgentIds = new Set(nextEntries.map((entry) => normalizeAgentId(entry.id)));
  const previousSoleAgentId = tryResolveDefaultAgentId(snapshot.config);
  const entersMultiAgent = previousEntries.length <= 1 && nextEntries.length > 1;
  const previousSoleRemains = Boolean(
    previousSoleAgentId && nextAgentIds.has(normalizeAgentId(previousSoleAgentId)),
  );
  const writesOwnershipTopology =
    options.persistCanonicalAgentRoster === true ||
    !isDeepStrictEqual(previousEntries, nextEntries) ||
    [...(options.explicitSetPaths ?? []), ...unsetPaths].some(
      (writePath) =>
        writePath[0] === "agents" &&
        (writePath.length === 1 ||
          writePath[1] === "entries" ||
          writePath[1] === "list" ||
          writePath[1] === "ownership"),
    );
  const persistOwnership =
    entersMultiAgent || (retainedLegacyDefaultAgentId !== undefined && writesOwnershipTopology);
  const keepOwnership = nextEntries.length > 1 && snapshot.config.agents?.ownership === "explicit";
  const stampOwnership =
    (persistOwnership || keepOwnership) && nextConfig.agents?.ownership === undefined;
  if (stampOwnership) {
    nextConfig = {
      ...nextConfig,
      agents: { ...nextConfig.agents, ownership: "explicit" },
    };
  }

  const workspaceCollapse = pinSurvivorWorkspaceForRosterCollapse(snapshot.config, nextConfig, env);
  nextConfig = workspaceCollapse.config;

  const authInheritanceOwnership = prepareAuthInheritanceOwnerForWrite({
    currentConfig: snapshot.config,
    targetConfig: nextConfig,
    writesOwnershipTopology,
    explicitSetPaths: options.explicitSetPaths,
    env,
  });
  nextConfig = authInheritanceOwnership.config;

  const sessionStoreOwnership = prepareSessionStoreOwnershipForWrite({
    currentConfig: snapshot.config,
    currentStore: (snapshot.sourceConfigBeforeMigrations ?? snapshot.config).session?.store,
    targetConfig: nextConfig,
    env,
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetValueSource,
  });
  nextConfig = sessionStoreOwnership.config;
  const { sameFixedSessionStore } = sessionStoreOwnership;
  const retainedFleetOwner =
    retainedLegacyDefaultAgentId &&
    writesOwnershipTopology &&
    nextAgentIds.has(normalizeAgentId(retainedLegacyDefaultAgentId))
      ? retainedLegacyDefaultAgentId
      : undefined;
  const ownerAgentId =
    (entersMultiAgent && previousSoleRemains ? previousSoleAgentId : undefined) ??
    retainedFleetOwner;
  const ownershipMaterialization = ownerAgentId
    ? await materializeLegacyAgentOwnershipForActiveChannelsResultAsync(
        nextConfig,
        ownerAgentId,
        env,
        pluginMetadataSnapshot?.manifestRegistry.plugins,
        { materializeSessionStore: sameFixedSessionStore, materializeWorkspace: true, homedir },
      )
    : { config: nextConfig, insertedPaths: [] };
  nextConfig = ownershipMaterialization.config;
  const insertedPaths = [
    ...ownershipMaterialization.insertedPaths.concat(workspaceCollapse.insertedPaths),
    ...authInheritanceOwnership.insertedPaths, // Persisting explicit ownership must replace the authored legacy roster too.
    ...sessionStoreOwnership.ownershipPaths, // Parent writes must not restore a removed fixed-store owner.
    ...(stampOwnership ? [["agents", "ownership"]] : []),
  ];

  const nextSessionStoreConfig = nextConfig.agents?.defaults?.sessionStore;
  if (
    !ownerAgentId &&
    writesOwnershipTopology &&
    previousEntries.length === 1 &&
    previousSoleAgentId &&
    !previousSoleRemains &&
    sameFixedSessionStore &&
    (nextSessionStoreConfig === undefined ||
      (isRecord(nextSessionStoreConfig) && !Object.hasOwn(nextSessionStoreConfig, "agentId")))
  ) {
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          sessionStore: {
            ...(isRecord(nextSessionStoreConfig) ? nextSessionStoreConfig : {}),
            agentId: normalizeAgentId(previousSoleAgentId),
          },
        },
      },
    };
    insertedPaths.push(["agents", "defaults", "sessionStore", "agentId"]);
  }

  const topologyPaths = [
    ...new Map(insertedPaths.map((entry) => [entry.join("\0"), entry])).values(),
  ];
  assertAutomaticBindingsWriteAllowed({
    bindingsIncludeOwned: snapshot.bindingsIncludeOwned === true,
    ownershipPaths: topologyPaths,
  });
  const explicitSetPaths = [...(options.explicitSetPaths ?? []), ...topologyPaths];
  const explicitSource = values.explicitSetValueSource;
  const explicitSetValueSource = { ...explicitSource };
  for (const ownershipPath of topologyPaths) {
    cloneConfigPathParents(explicitSource, explicitSetValueSource, ownershipPath);
    setConfigValueAtPath(
      explicitSetValueSource,
      ownershipPath,
      getConfigValueAtPath(nextConfig, ownershipPath),
    );
  }
  return {
    nextConfig,
    clearedSessionStoreOwner: sessionStoreOwnership.ownershipPaths.length > 0,
    resolutionEnv: values.resolutionEnv,
    // Apply topology changes to the paired authored view without materializing untouched refs.
    authoredConfig:
      nextConfig === values.resolvedConfig
        ? values.authoredConfig
        : coerceConfig(
            restoreEnvVarRefsFromResolved(nextConfig, values.authoredConfig, values.resolvedConfig),
          ),
    authoredSourceConfig: values.authoredSourceConfig,
    authoredRuntimeConfig: values.authoredRuntimeConfig,
    explicitSetPaths,
    explicitSetValueSource,
    persistCanonicalAgentRoster:
      options.persistCanonicalAgentRoster === true ||
      persistOwnership ||
      stampOwnership ||
      (retiredMarkers?.changes.length ?? 0) > 0,
    preserveLegacyAgentRoster: Boolean(retainedLegacyDefaultAgentId) && !writesOwnershipTopology,
    cronOwner: persistOwnership
      ? retainedLegacyDefaultAgentId
        ? { provenOwnerAgentId: retainedLegacyDefaultAgentId }
        : {}
      : undefined,
  };
}
