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

async function respondWithContract(
  params: Record<string, unknown>,
  respond: RespondFn,
  implementation: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  try {
    respond(true, await implementation(params), undefined);
  } catch (error) {
    const message =
      error instanceof ContractInputError ? error.message : "Agentic OS runtime contract failure";
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  }
}

function contractHandler(
  implementation: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): GatewayRequestHandler {
  return async ({ params, respond }) => {
    await respondWithContract(params, respond, implementation);
  };
}

export const agenticOsRuntimeContractHandlers: GatewayRequestHandlers = {
  "subagents.allowLease.acquire": async ({ params, respond }) => {
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
    await respondWithContract(params, respond, acquireAgenticOsAllowLease);
  },
  "subagents.allowLease.status": async ({ params, respond }) => {
    void params;
    await respondWithContract(params, respond, () => listAgenticOsAllowLeases());
  },
  "subagents.allowLease.release": async ({ params, respond }) => {
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
    await respondWithContract(params, respond, releaseAgenticOsAllowLease);
  },
  sessions_spawn: contractHandler(spawnAgenticOsSession),
  sessions_list: contractHandler(() => listAgenticOsSessions()),
  sessions_status: contractHandler(statusAgenticOsSession),
  sessions_history: contractHandler(historyAgenticOsSession),
};
