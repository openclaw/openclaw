import {
  prepareCombinedSessionStore,
  resolveGatewaySessionStoreTargets,
} from "./combined-store-gateway.js";
import type {
  CombinedSessionStoreTopologyRequest,
  CombinedSessionStoreTopologyResult,
  GatewaySessionStoreOptions,
  ResolvedGatewaySessionStoreTargets,
} from "./combined-store.types.js";
import { listKnownSessionStoreAgentIds } from "./targets.js";

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
              key,
              resolveGatewaySessionStoreTargets(request.config, {
                ...selection,
                includeIncognito: false,
                discovery: options.discovery,
              }),
            ];
          } catch (error) {
            return [key, error instanceof Error ? error : new Error(String(error))];
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
