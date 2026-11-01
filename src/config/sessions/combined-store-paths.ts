import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveRequiredHomeDir, resolveUserPath } from "../../infra/home-dir.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import { getAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import {
  createRetainedAgentDatabaseMatcher,
  createRetainedAgentDatabaseMatcherFromSnapshot,
} from "../../state/agent-deletion-discovery.js";
import { getPreparedAgentDeletionDiscovery } from "../../state/agent-deletion-journal-status.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { GatewaySessionStoreDiscovery } from "./combined-store.types.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { resolvePersistedSessionStoreOwner } from "./session-store-owner.js";
import {
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
  type SessionStoreTarget,
} from "./targets.js";

const configuredAdmissionPaths = new WeakMap<
  OpenClawConfig,
  {
    admission: ReturnType<typeof getAgentDatabaseStartupAdmission>;
    registryToken: symbol;
    context: string;
    paths: ReadonlySet<string>;
  }
>();

export function createGatewayConfiguredDatabaseMatcher(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
) {
  const admission = getAgentDatabaseStartupAdmission();
  const registryToken = readOpenClawAgentDatabaseRegistryToken({ env });
  const context = JSON.stringify([
    resolveStateDir(env),
    resolveRequiredHomeDir(env),
    resolveUserPath("."),
  ]);
  const cached = isDeeplyFrozenPlainData(cfg) ? configuredAdmissionPaths.get(cfg) : undefined;
  const paths =
    cached &&
    cached.admission === admission &&
    cached.registryToken === registryToken &&
    cached.context === context
      ? cached.paths
      : new Set(resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env }));
  if (paths !== cached?.paths && isDeeplyFrozenPlainData(cfg)) {
    configuredAdmissionPaths.set(cfg, { admission, registryToken, context, paths });
  }
  // Exact configured claims need no disk evidence. Alias evidence belongs to this read so
  // replacing or retargeting a file cannot reuse an earlier filesystem observation.
  let physical: { key: (pathname: string) => string; paths: Set<string> } | undefined;
  const candidates = paths.values();
  return (pathname: string): boolean => {
    if (paths.has(pathname)) {
      return true;
    }
    if (!fs.statSync(pathname, { throwIfNoEntry: false })) {
      return false;
    }
    physical ??= {
      key: createOpenClawAgentDatabasePathMatcher().createIndex(),
      paths: new Set(),
    };
    const requestedKey = physical.key(pathname);
    if (physical.paths.has(requestedKey)) {
      return true;
    }
    for (const candidate of candidates) {
      try {
        if (!fs.statSync(candidate, { throwIfNoEntry: false })) {
          continue;
        }
        const candidateKey = physical.key(candidate);
        physical.paths.add(candidateKey);
        if (candidateKey === requestedKey) {
          return true;
        }
      } catch {
        // Startup owns sibling inspection refusals; they cannot block a healthy alias.
      }
    }
    return false;
  };
}

export function storeTargetKey(target: SessionStoreTarget): string {
  return `${target.agentId}\0${target.storePath}`;
}

// Template-backed stores need per-agent scans before they can be merged for Gateway views.
export function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

export function resolveCombinedStorePath(paths: string[], storeConfig?: string): string {
  return paths.length === 1
    ? expectDefined(paths[0], "store path at 0")
    : typeof storeConfig === "string" && storeConfig.trim()
      ? storeConfig.trim()
      : "(multiple)";
}

export function resolveCombinedDatabasePath(
  targets: readonly SessionStoreTarget[],
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>,
): string {
  const paths = [
    ...new Set(
      targets.map(
        (target) =>
          expectDefined(physicalTargets.get(storeTargetKey(target)), "physical store").storePath,
      ),
    ),
  ];
  return paths.length === 1 ? expectDefined(paths[0], "database path at 0") : "(multiple)";
}

function discoveryReadOptions(discovery?: GatewaySessionStoreDiscovery) {
  return discovery
    ? {
        env: discovery.env,
        readCandidates: discovery.readCandidates,
        registeredDatabases: (discovery.snapshot?.registeredAgentDatabases ?? []).filter(
          (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
        ),
      }
    : {};
}

/** Exclude retired discovery targets before resolution can open their databases. */
export function gatewayDiscoveryReadOptions(
  cfg: OpenClawConfig,
  discovery?: GatewaySessionStoreDiscovery,
) {
  const excluded = createGatewayRetainedStoreMatcher(cfg, discovery);
  const unavailable = discovery?.recoveryExclusions;
  return {
    ...discoveryReadOptions(discovery),
    excludeTarget: (target: SessionStoreTarget) => {
      const databasePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path;
      return (
        unavailable?.agentIds.includes(target.agentId) === true ||
        unavailable?.storePaths.includes(target.storePath) === true ||
        unavailable?.databasePaths.includes(databasePath) === true ||
        Boolean(excluded(databasePath, target.agentId))
      );
    },
  };
}

export function resolveSharedStoreRowOwner(
  cfg: OpenClawConfig,
  selected: SessionStoreTarget,
  sharedStorePaths: ReadonlySet<string>,
  env?: NodeJS.ProcessEnv,
): { agentId: string; target: SessionStoreTarget } | undefined {
  const configuredPath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: resolveSessionStoreCompatibilityAgentId(cfg),
    env,
  });
  // Registry aliases do not turn legacy selectors into shared stores. Reuse the
  // configured selector's own classification from the physical dedupe pass.
  if (!sharedStorePaths.has(configuredPath)) {
    return undefined;
  }
  const persistedOwner = resolvePersistedSessionStoreOwner(cfg);
  return persistedOwner.kind === "configured"
    ? { agentId: persistedOwner.agentId, target: selected }
    : undefined;
}

export function createGatewayRetainedStoreMatcher(
  cfg: OpenClawConfig,
  discovery?: GatewaySessionStoreDiscovery,
) {
  const readOptions = discoveryReadOptions(discovery);
  const env = readOptions.env ?? process.env;
  const readConfiguredTargets = () =>
    resolveConfiguredAgentDatabaseTargets(cfg, { env, ...readOptions });
  const prepared = discovery
    ? undefined
    : getPreparedAgentDeletionDiscovery(resolveOpenClawStateSqlitePath(env));
  const snapshot =
    discovery?.snapshot ??
    (prepared && {
      retainedDeletions: prepared,
      registeredAgentDatabases: listOpenClawRegisteredAgentDatabases({ env }),
    });
  if (!discovery && !snapshot && getPluginRuntimeGatewayRequestScope()) {
    throw new Error(
      "Session discovery requires worker preparation; await the asynchronous session store loader.",
    );
  }
  // The shipped synchronous SDK also supports offline one-shot callers without a Gateway.
  return discovery || snapshot
    ? createRetainedAgentDatabaseMatcherFromSnapshot(
        env,
        readConfiguredTargets,
        snapshot,
        "database",
        "runtime-discovery",
      )
    : createRetainedAgentDatabaseMatcher(
        env,
        readConfiguredTargets,
        "database",
        "runtime-discovery",
      );
}
