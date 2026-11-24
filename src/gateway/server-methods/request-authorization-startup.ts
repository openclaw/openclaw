import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import {
  resolveRequestedSessionAgentId,
  resolveSessionCreateAgentId,
} from "../session-request-agent.js";
import {
  readSessionSharingStringParam,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
} from "../session-sharing-target-input.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestContext } from "./types.js";

/** Agents a request touches while their databases are still admitting at Gateway startup. */
export const STARTUP_READ_WAIT_MS = 20_000;
export const startupReadMethods = new Set([
  "sessions.list",
  "sessions.resolve",
  "sessions.describe",
  "models.list",
  "chat.metadata",
  "board.get",
  "sessions.messages.subscribe",
]);

export function startupWriteAgents(
  params: { method: string; requestParams: unknown; context: GatewayRequestContext },
  cfg: OpenClawConfig,
) {
  const refusals = listAgentDatabaseAdmissionRefusals();
  const targets = resolveSessionMutationTargets(params) ?? [];
  const selected = targets.map((target) =>
    resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId),
  );
  if (params.method === "sessions.create") {
    selected.push(
      resolveSessionCreateAgentId(cfg, {
        key: readSessionSharingStringParam(params.requestParams, "key"),
        agentId: readSessionSharingStringParam(params.requestParams, "agentId"),
        parentSessionKey: readSessionSharingStringParam(params.requestParams, "parentSessionKey"),
      }),
    );
  } else if (params.method === "agent" && targets.length === 0) {
    selected.push(
      resolveRequestedSessionAgentId(
        cfg,
        undefined,
        readSessionSharingStringParam(params.requestParams, "agentId"),
      ),
    );
  }
  return [
    ...new Set(
      selected.flatMap((result) =>
        result.ok
          ? [result.agentId]
          : refusals
              .filter((refusal) => refusal === result.error.details)
              .map(({ agentId }) => agentId),
      ),
    ),
  ];
}

export function startupWriteRefusal(agents: string[]) {
  const refusals = agents
    .map((agentId) => readAgentDatabaseAdmissionRefusal(agentId))
    .filter((refusal) => refusal !== undefined);
  return (
    refusals.find((refusal) => refusal.code !== "agent-database-inspection-pending") ?? refusals[0]
  );
}

export function startupReadAgents(method: string, requestParams: unknown, cfg: OpenClawConfig) {
  const refusals = listAgentDatabaseAdmissionRefusals();
  const targets = resolveDirectSessionTargets(method, requestParams);
  if (targets.length > 0) {
    return targets.flatMap((target) => {
      const resolved = resolveRequestedSessionAgentId(
        cfg,
        target.sessionKey,
        target.agentId,
        "read",
      );
      return resolved.ok
        ? [resolved.agentId]
        : refusals
            .filter((refusal) => refusal === resolved.error.details)
            .map(({ agentId }) => agentId);
    });
  }
  const agentId = readSessionSharingStringParam(requestParams, "agentId");
  if (method === "models.list") {
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: agentId ?? tryResolveAmbientOwnerAgentId(cfg),
      cfg,
      respond: () => {},
    });
    return resolved ? [resolved.agentId] : [];
  }
  return agentId ? [agentId] : listAgentIds(cfg);
}

export async function prepareStartupReadAgents(
  method: string,
  requestParams: unknown,
  cfg: OpenClawConfig,
  signal: AbortSignal,
) {
  const agents = startupReadAgents(method, requestParams, cfg);
  if (method === "models.list" && !readSessionSharingStringParam(requestParams, "sessionKey")) {
    return agents;
  }
  return prepareStartupAgentTargets(agents, cfg, signal);
}

async function prepareStartupAgentTargets(
  agents: string[],
  cfg: OpenClawConfig,
  signal: AbortSignal,
) {
  return [...new Set([...agents, ...(await prepareStartupStoreAgents(agents, cfg, signal))])];
}

export async function prepareStartupStoreAgents(
  agents: string[],
  cfg: OpenClawConfig,
  signal: AbortSignal,
) {
  const targets = await Promise.all(
    agents.map((agentId) =>
      prepareSqliteTargetFromSessionStorePath(
        resolveSessionStorePathCore(cfg.session?.store, { agentId }),
        {
          agentId,
          defaultAgentId: isPerAgentSessionStoreConfig(cfg.session?.store)
            ? agentId
            : resolveSessionStoreCompatibilityAgentId(cfg),
        },
        signal,
      ),
    ),
  );
  return [...new Set(targets.flatMap(({ agentId }) => agentId ?? []))];
}
