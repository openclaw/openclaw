import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveGatewaySessionStoreTargets } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

/** Resolve query-specific federation once when the physical topology is published. */
export function prepareSessionRowScopes(
  cfg: OpenClawConfig,
  agentIds: Iterable<string>,
  residentPaths: ReadonlyMap<string, string>,
) {
  const residentPath = (pathname: string) => residentPaths.get(pathname) ?? pathname;
  const filenames = new Map([...residentPaths].map(([filename, locator]) => [locator, filename]));
  const aliases = new Map<string, Map<string, string>>();
  const capture = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    try {
      const resolved = resolveGatewaySessionStoreTargets(cfg, {
        ...options,
        includeIncognito: false,
      });
      for (const [identity, physical] of resolved.physicalTargets) {
        const separator = identity.indexOf("\0");
        const agentId = identity.slice(0, separator);
        const locator = path.resolve(identity.slice(separator + 1));
        const owners = aliases.get(locator) ?? new Map<string, string>();
        owners.set(agentId, residentPath(physical.storePath));
        aliases.set(locator, owners);
      }
      const paths = resolved.durableTargets.map((target) =>
        residentPath(
          expectDefined(
            resolved.physicalTargets.get(`${target.agentId}\0${target.storePath}`),
            "physical source",
          ).storePath,
        ),
      );
      return {
        paths: new Map(paths.map((pathname, index) => [pathname, index])),
        path: paths.length === 1 ? (filenames.get(paths[0]!) ?? paths[0]!) : "(multiple)",
        configuredAgentIds: resolved.configuredAgentIds,
        agentId: resolved.requestedAgentId,
      };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const all = capture({});
  const configured = capture({ configuredAgentsOnly: true });
  const agents = new Map(
    [...new Set([...listAgentIds(cfg), ...agentIds])].map((agentId) => [
      agentId,
      capture({ agentId }),
    ]),
  );
  const select = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    const requestedAgentId = options.agentId?.trim()
      ? normalizeAgentId(options.agentId)
      : undefined;
    const scope = requestedAgentId
      ? (agents.get(requestedAgentId) ?? {
          paths: new Map<string, number>(),
          path: "(multiple)",
          agentId: requestedAgentId,
          configuredAgentIds: undefined,
        })
      : options.configuredAgentsOnly
        ? configured
        : all;
    if (scope instanceof Error) {
      throw scope;
    }
    return scope;
  };
  return {
    select,
    physicalPaths(locator: string, agentId?: string) {
      const normalized = residentPath(path.resolve(locator));
      const owners = aliases.get(normalized);
      return agentId
        ? [owners?.get(normalizeAgentId(agentId)) ?? normalized]
        : owners
          ? [...new Set(owners.values())]
          : [normalized];
    },
  };
}
