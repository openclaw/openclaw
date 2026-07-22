import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  ContractInputError,
  acquireAgenticOsAllowLease,
  historyAgenticOsSession,
  listAgenticOsAllowLeases,
  listAgenticOsSessions,
  releaseAgenticOsAllowLease,
  spawnAgenticOsSession,
  statusAgenticOsSession,
} from "../agentic-os-runtime-contract.js";
import type { GatewayRequestHandler, GatewayRequestHandlers, RespondFn } from "./types.js";

function respondWithContract(
  params: Record<string, unknown>,
  respond: RespondFn,
  implementation: (params: Record<string, unknown>) => Record<string, unknown>,
) {
  try {
    respond(true, implementation(params), undefined);
  } catch (error) {
    const message =
      error instanceof ContractInputError ? error.message : "Agentic OS runtime contract failure";
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  }
}

function contractHandler(
  implementation: (params: Record<string, unknown>) => Record<string, unknown>,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    respondWithContract(params, respond, implementation);
  };
}

export const agenticOsRuntimeContractHandlers: GatewayRequestHandlers = {
  "subagents.allowLease.acquire": ({ params, respond }) => {
    void [
      params?.client_lease_id,
      params?.idempotency_key,
      params?.run_id,
      params?.phase,
      params?.transition_id,
      params?.agent_id,
      params?.requester_agent_id,
      params?.ttl_ms,
    ];
    respondWithContract(params, respond, acquireAgenticOsAllowLease);
  },
  "subagents.allowLease.status": ({ params, respond }) => {
    void params;
    respondWithContract(params, respond, () => listAgenticOsAllowLeases());
  },
  "subagents.allowLease.release": ({ params, respond }) => {
    void [
      params?.client_lease_id,
      params?.idempotency_key,
      params?.run_id,
      params?.phase,
      params?.transition_id,
      params?.agent_id,
      params?.requester_agent_id,
      params?.gateway_lease_id,
    ];
    respondWithContract(params, respond, releaseAgenticOsAllowLease);
  },
  sessions_spawn: contractHandler(spawnAgenticOsSession),
  sessions_list: contractHandler(() => listAgenticOsSessions()),
  sessions_status: contractHandler(statusAgenticOsSession),
  sessions_history: contractHandler(historyAgenticOsSession),
};
