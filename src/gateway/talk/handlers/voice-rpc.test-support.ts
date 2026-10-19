import { expect, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "../../server-methods/types.js";
import { talkVoiceHandlers } from "./voice.js";

export function voiceRuntimes() {
  const authorities: AgentRunDelegatedAuthority[] = [];
  return {
    create(agentId: string, sessionKey: string) {
      const runId = `voice-rpc-run-${authorities.length}`;
      registerAgentRunContext(runId, { agentId, sessionKey });
      const authority = claimAgentRunDelegatedAuthority({ instanceId: `${runId}-instance`, runId });
      authorities.push(authority);
      const client = voiceClient(`runtime-${runId}`);
      client.internal = {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId,
          sessionKey,
          operationalRunInstance: authority.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...authority },
        },
      };
      return { authority, runId, client, connId: client.connId };
    },
    cleanup() {
      for (const authority of authorities.splice(0)) {
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext(authority.operationalRunInstance.runId);
      }
    },
  };
}

export function voiceClient(connId: string): GatewayClient & { connId: string } {
  return {
    connId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
}

export function voiceRpc(
  pending: Promise<void>[],
  options: () => Pick<
    GatewayRequestHandlerOptions,
    "context" | "client" | "sessionMutationCommitGuard"
  >,
) {
  function start(method: string, params: Record<string, unknown>, client = options().client) {
    const handler = talkVoiceHandlers[method];
    if (!handler) {
      throw new Error(`Missing Talk voice handler: ${method}`);
    }
    const respond = vi.fn<RespondFn>();
    const completed = Promise.resolve(
      handler({
        ...options(),
        client,
        params,
        respond,
        req: { type: "req", id: `request-${pending.length}`, method, params },
        isWebchatConnect: () => false,
      }),
    );
    pending.push(completed);
    return { respond, completed };
  }
  return {
    start,
    async invoke(
      this: void,
      method: string,
      params: Record<string, unknown>,
      client = options().client,
    ) {
      const request = start(method, params, client);
      await request.completed;
      return request.respond;
    },
  };
}

export function expectSuccess(respond: RespondFn, result: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(result), undefined);
}

export function expectFailure(respond: RespondFn, message?: string) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    message === undefined
      ? expect.any(Object)
      : expect.objectContaining({ message: expect.stringContaining(message) }),
  );
}
