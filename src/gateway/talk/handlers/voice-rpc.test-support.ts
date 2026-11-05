import { expect, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { GatewayClient, RespondFn } from "../../server-methods/types.js";
import { gatewayConnect } from "../../server/client-fixtures.test-support.js";
import { talkVoiceHandlers } from "./voice.js";
type HandlerOptions = Parameters<(typeof talkVoiceHandlers)[string]>[0];
export function voiceRuntimes() {
  const authorities: ReturnType<typeof claimAgentRunDelegatedAuthority>[] = [];
  return {
    create(agentId: string, sessionKey: string) {
      const runId = `voice-rpc-run-${authorities.length}`;
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
    cleanup: () => authorities.splice(0).forEach(releaseAgentRunDelegatedAuthority),
  };
}

export const voiceClient = (connId: string): GatewayClient & { connId: string } => ({
  connId,
  connect: gatewayConnect(["operator.admin"], { id: "gateway-client", mode: "backend" }),
});

export function voiceRpc(
  pending: Promise<void>[],
  options: () => Pick<HandlerOptions, "context" | "client" | "sessionMutationCommitGuard">,
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
    invoke: (...args: Parameters<typeof start>) => {
      const { respond, completed } = start(...args);
      return completed.then(() => respond);
    },
  };
}

export function expectSuccess(respond: RespondFn, result: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(result), undefined);
}

export function expectFailure(respond: RespondFn, message?: string) {
  const error =
    message === undefined
      ? expect.any(Object)
      : expect.objectContaining({ message: expect.stringContaining(message) });
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}
