import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.ts";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createAdmittedRunOperatorAuthority } from "../../../src/agents/admitted-run-context.js";
import type { AgentQuestionDispatcher } from "../../../src/agents/harness/gateway-question-dispatch.js";
import { createAskUserTool } from "../../../src/agents/tools/ask-user-tool.js";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../src/gateway/agent-runtime-approval-authority.js";
import type { OperatorScope } from "../../../src/gateway/operator-scopes.js";
import { QuestionManager } from "../../../src/gateway/question-manager.js";
import { createGatewayBroadcaster } from "../../../src/gateway/server-broadcast.js";
import { createDirectChatContext } from "../../../src/gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../../src/gateway/server-methods.js";
import { createQuestionHandlers } from "../../../src/gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../../../src/gateway/server-methods/secrets.js";
import type { GatewayClient, RespondFn } from "../../../src/gateway/server-methods/types.js";
import { GatewayClientRegistry } from "../../../src/gateway/server/client-registry.js";
import type { GatewayWsClient } from "../../../src/gateway/server/ws-types.js";
import { canReceiveSessionEvent } from "../../../src/gateway/session-sharing.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
} from "../../../src/infra/agent-run-registry.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.js";

export const guestQuestionSessionKey = "agent:main:guest-question-proof";
export const guestQuestionPrompt = "Which format should I use for your summary?";
export const guestQuestionScopes: OperatorScope[] = ["operator.sessions.write"];

type RpcResult = { ok: boolean; payload: unknown; error: Parameters<RespondFn>[2] };

export async function createGuestQuestionFixture(deliver: (frame: unknown) => Promise<void>) {
  const profile = ensureProfileForEmail("guest-question@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: "*", scopes: guestQuestionScopes },
        },
      },
    },
  };
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: guestQuestionSessionKey },
    {
      sessionId: "guest-question-session",
      lifecycleRevision: "guest-question-generation",
      updatedAt: Date.now(),
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: profile.id },
    },
  );
  const runId = "guest-question-run";
  registerAgentRunContext(runId, { agentId: "main", sessionKey: guestQuestionSessionKey });
  const source = new AbortController();
  const requesterAuthority = claimAgentRunDelegatedAuthority({
    instanceId: "guest-question-instance",
    runId,
  });
  const manager = new QuestionManager();
  const unregister = registerAgentRunDelegatedAuthorityClosedHandler((authority) =>
    manager.cancelClosedAuthorities(authority.operationalRunInstance),
  );
  const frames: unknown[] = [];
  let delivery = Promise.resolve();
  let deliveryError: Error | undefined;
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    close() {},
    terminate() {},
    send(wire: string, callback?: (error?: Error) => void) {
      const frame: unknown = JSON.parse(wire);
      frames.push(frame);
      delivery = delivery
        .then(() => deliver(frame))
        .then(
          () => callback?.(),
          (error: unknown) => {
            deliveryError =
              error instanceof Error
                ? error
                : new Error("Question event delivery failed", { cause: error });
            callback?.(deliveryError);
          },
        );
    },
  });
  const browser: GatewayWsClient = {
    connId: "guest-question-browser",
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: guestQuestionScopes,
      client: { id: "openclaw-control-ui", version: "e2e", platform: "web", mode: "ui" },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: "Guest",
      avatarRevision: "fixture",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  };
  const runtime: GatewayClient = {
    ...browser,
    connect: {
      ...browser.connect,
      client: { id: "gateway-client", version: "e2e", platform: "test", mode: "backend" },
    },
    internal: {
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: profile.id,
        scopes: guestQuestionScopes,
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      }),
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: guestQuestionSessionKey,
        operationalRunInstance: requesterAuthority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...requesterAuthority },
      },
    },
  };
  const clients = new GatewayClientRegistry([browser]);
  const { broadcast } = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({ cfg, client, sessionKeys, agentId, event, payload }),
  });
  const context = createDirectChatContext({
    broadcast,
    questionManager: manager,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getRuntimeConfig: () => cfg,
  });
  const handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
  );
  const requests: Array<{ method: string; params: unknown; result?: RpcResult }> = [];
  const registration = createDeferredCore<RpcResult>();
  const ownerScope = AsyncLocalStorage.snapshot();
  const flushEvents = async () => {
    await delivery;
    if (deliveryError) {
      throw deliveryError;
    }
  };
  const request = (client: GatewayClient, method: string, params: unknown, signal?: AbortSignal) =>
    ownerScope(async () => {
      const call: (typeof requests)[number] = { method, params };
      requests.push(call);
      const response = createDeferredCore<RpcResult>();
      await handleGatewayRequest({
        req: { type: "req", id: `guest-question-${requests.length}`, method, params },
        client,
        signal,
        context,
        extraHandlers: handlers,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          call.result = { ok, payload, error };
          response.resolve(call.result);
          if (method === "question.request") {
            registration.resolve(call.result);
          }
        },
      });
      await flushEvents();
      return response.promise;
    });
  const gatewayCall: AgentQuestionDispatcher = {
    version: 2,
    async call({ method, params, signal, authority }) {
      signal?.throwIfAborted();
      if (authority.kind === "source-bound") {
        authority.assertCurrent();
      }
      const result = await request(runtime, method, params, signal);
      if (!result.ok) {
        throw new GatewayClientRequestError(result.error ?? { message: "question RPC failed" });
      }
      return result.payload;
    },
  };
  const tool = createAskUserTool({
    agentId: "main",
    sessionKey: guestQuestionSessionKey,
    runId,
    gatewayCall,
  });
  return {
    profileId: profile.id,
    registration: registration.promise,
    requests,
    frames,
    flushEvents,
    request: (method: string, params: unknown) => request(browser, method, params),
    ask: (toolCallId: string, signal?: AbortSignal) =>
      tool.execute(
        toolCallId,
        {
          questions: [
            {
              id: "format",
              header: "Format",
              question: guestQuestionPrompt,
              options: [{ label: "Concise" }, { label: "Detailed" }],
            },
          ],
          timeoutSeconds: 120,
        },
        signal,
      ),
    disconnect: () => clients.delete(browser),
    reconnect: () => clients.add(browser),
    async close() {
      clients.clear();
      source.abort();
      releaseAgentRunDelegatedAuthority(requesterAuthority);
      unregister();
      manager.close();
      clearAgentRunContext(runId);
      await flushEvents();
    },
  };
}
