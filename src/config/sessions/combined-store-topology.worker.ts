import type { OpenClawConfig } from "../types.openclaw.js";
import {
  prepareCombinedSessionStore,
  resolveGatewaySessionStoreTargets,
  type GatewaySessionStoreOptions,
  type ResolvedGatewaySessionStoreTargets,
} from "./combined-store-gateway.js";
import type { SessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { listKnownSessionStoreAgentIds } from "./targets.js";

export type CombinedSessionStoreTopologyRequest = {
  config: OpenClawConfig;
  options: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded"> & {
    discovery: NonNullable<GatewaySessionStoreOptions["discovery"]>;
  };
  candidates: readonly SessionStoreReadCandidate[];
  scopeAgentIds?: readonly string[];
};

export type CombinedSessionStoreScopeTargets = ReadonlyMap<
  string,
  ResolvedGatewaySessionStoreTargets | Error
>;

export type CombinedSessionStoreTopologyResult = {
  kind: "combined-store-topology";
  prepared: ReturnType<typeof prepareCombinedSessionStore>;
  scopes?: CombinedSessionStoreScopeTargets;
};

/** Resolve durable federation in the existing discovery worker; the host owns incognito rows. */
export function readCombinedSessionStoreTopology(
  request: CombinedSessionStoreTopologyRequest,
): CombinedSessionStoreTopologyResult {
  const options = {
    ...request.options,
    includeIncognito: false,
    discovery: { ...request.options.discovery, readCandidates: request.candidates },
  };
  const agentIds = request.scopeAgentIds
    ? [
        ...new Set([
          ...request.scopeAgentIds,
          ...listKnownSessionStoreAgentIds(request.config, {
            env: options.discovery.env,
            registeredDatabases: options.discovery.snapshot?.registeredAgentDatabases ?? [],
            readCandidates: request.candidates,
          }),
        ]),
      ]
    : [];
  const selections: Array<
    [string, Pick<GatewaySessionStoreOptions, "agentId" | "configuredAgentsOnly">]
  > = [
    ["all", {}],
    ["configured", { configuredAgentsOnly: true }],
    ...agentIds.map((agentId): [string, { agentId: string }] => [`agent:${agentId}`, { agentId }]),
  ];
  const scopes = request.scopeAgentIds
    ? new Map(
        selections.map(([key, selection]): [string, ResolvedGatewaySessionStoreTargets | Error] => {
          try {
            return [
              String(key),
              resolveGatewaySessionStoreTargets(request.config, {
                ...selection,
                includeIncognito: false,
                discovery: options.discovery,
              }),
            ];
          } catch (error) {
            return [String(key), error instanceof Error ? error : new Error(String(error))];
          }
        }),
      )
    : undefined;
  return {
    kind: "combined-store-topology",
    prepared: prepareCombinedSessionStore(request.config, options),
    ...(scopes ? { scopes } : {}),
  };
}
