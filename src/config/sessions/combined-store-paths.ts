import { expectDefined } from "@openclaw/normalization-core";
import {
  createRetainedAgentDatabaseMatcher,
  createRetainedAgentDatabaseMatcherFromSnapshot,
} from "../../state/agent-deletion-discovery.js";
import type { AgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolvePersistedSessionStoreOwner } from "./session-store-owner.js";
import { resolveConfiguredAgentDatabaseTargets, type SessionStoreTarget } from "./targets.js";

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

export type GatewaySessionStoreDiscovery = {
  env: NodeJS.ProcessEnv;
  snapshot: AgentDatabaseDeletionSnapshot | undefined;
};

export function discoveryReadOptions(discovery?: GatewaySessionStoreDiscovery) {
  return discovery
    ? {
        env: discovery.env,
        registeredDatabases: (discovery.snapshot?.registeredAgentDatabases ?? []).filter(
          (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
        ),
      }
    : {};
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
  return discovery
    ? createRetainedAgentDatabaseMatcherFromSnapshot(
        env,
        readConfiguredTargets,
        discovery.snapshot,
        "database",
        "runtime",
      )
    : createRetainedAgentDatabaseMatcher(env, readConfiguredTargets, "database", "runtime");
}
