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
import { listKnownSessionStoreAgentIds } from "./targets-discovery.native.js";

/** Resolve durable federation in the existing discovery worker; the host owns incognito rows. */
export function readCombinedSessionStoreTopology(
  request: CombinedSessionStoreTopologyRequest,
): CombinedSessionStoreTopologyResult {
  const options = {
    ...request.options,
    includeIncognito: false,
    discovery: { ...request.options.discovery, readCandidates: request.candidates },
  };
  const prepared = prepareCombinedSessionStore(request.config, options);
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
          // Indexed discovery must use the same physical stores as the prepared rows.
          if (key === "all") {
            return [key, prepared.targets];
          }
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
    prepared,
    ...(scopes ? { scopes } : {}),
  };
}
