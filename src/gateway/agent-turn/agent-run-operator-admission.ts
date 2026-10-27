import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

/** Bind operator and cancellation custody to the same canonical agent admission snapshot. */
export function retainAgentRunOperator(
  params: PrepareAgentRunDispatchParams,
  entry: RpcSourceRef | undefined,
) {
  return retainGatewayOperatorRun({
    ...params,
    spawnedBy: params.sessionEntry?.spawnedBy,
    workspaceSession:
      params.resolvedSessionKey && params.sessionEntry
        ? {
            agentId: params.activeSessionAgentId,
            sessionKey: params.resolvedSessionKey,
            entry: params.sessionEntry,
          }
        : undefined,
    entry,
    abortSession: params.resolvedSessionKey
      ? {
          cfg: params.cfg,
          storePath: params.lifecycleStorePath,
          entry: params.sessionEntry,
          canonicalKey: params.resolvedSessionKey,
          agentId: params.activeSessionAgentId,
        }
      : undefined,
  });
}
