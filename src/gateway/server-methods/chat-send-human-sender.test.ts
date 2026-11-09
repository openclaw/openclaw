import { expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { readHumanSenderTurn } from "../../plugins/memory-human-sender-turn.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { markExternalGatewayRequestFrame } from "../external-request-frame.js";
import { createChatRunState } from "../server-chat-state.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import type * as chatDispatch from "./chat-send-agent-dispatch.js";
import { holdProjectedChatDispatch } from "./chat-send-authority.test-support.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const PARENT_KEY = "agent:main:main";
const CHILD_KEY = "agent:main:subagent:typed-child";

function createContext() {
  return {
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getRuntimeConfig,
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function createClient(scopes: string[], authenticated: boolean): GatewayClient {
  return {
    connId: "typed-child-operator",
    ...(authenticated ? { internal: { authenticatedOperator: true as const } } : {}),
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    },
  };
}

it.each([
  ["owner typing on the transport", "external", true, true, true, true],
  ["non-owner typing on the transport", "external", false, true, true, false],
  ["unauthenticated connection", "external", true, false, true, undefined],
  // Plugin RPC and sessions.send re-entry keep the operator client but build their own frame.
  ["in-process re-entry of the external entry", "external", true, true, false, undefined],
  ["internal re-entry", "internal", true, true, true, undefined],
] as const)(
  "attests the human sender of a spawned session for an %s",
  async (_name, entry, admin, authenticated, transportFrame, expectedOwner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await loadOrCreateProcessDeviceIdentityAsync();
      setRuntimeConfigSnapshot({});
      const runId = `typed-child-${entry}-${admin}-${authenticated}-${transportFrame}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: CHILD_KEY },
        {
          sessionId: runId,
          updatedAt: Date.now(),
          spawnedBy: PARENT_KEY,
          parentSessionKey: PARENT_KEY,
          spawnedBySenderIsOwner: true,
        },
      );
      const client = createClient(
        admin ? ["operator.read", "operator.write", "operator.admin"] : ["operator.write"],
        authenticated,
      );
      const context = createContext();
      const params = { sessionKey: CHILD_KEY, message: "Recall my notes", idempotencyKey: runId };
      const authorization = await resolveSessionMutationAuthorizationAsync({
        client,
        context,
        method: "chat.send",
        requestParams: params,
      });
      expect(authorization.error).toBeNull();
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const { entered, release, observe, hold } = holdProjectedChatDispatch();
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      try {
        const req = { type: "req" as const, id: runId, method: "chat.send", params };
        if (transportFrame) {
          markExternalGatewayRequestFrame(req);
        }
        const request = {
          params,
          client,
          context,
          respond: vi.fn(),
          req,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        };
        await (entry === "external" ? handleDirectExternalChatSend : handleChatSend)(request);
        const options = await entered.promise;
        owned = observe.mock.calls.at(-1)?.[0];
        const turn = options.replyOptions?.humanSenderTurn;
        expect(Boolean(turn)).toBe(expectedOwner !== undefined);
        if (turn) {
          const admitted = await namespaceRun.admit("embedded");
          const run = {
            sessionKey: CHILD_KEY,
            operationalRunInstance: admitted.operationalRunInstance,
          };
          expect(readHumanSenderTurn(turn, run)).toBeUndefined();
          turn.bind(admitted);
          expect(readHumanSenderTurn(turn, run)).toEqual({ senderIsOwner: expectedOwner });
        }
      } finally {
        namespaceRun.close();
        release.resolve();
        if (owned) {
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        authorization.authorization?.release?.();
        hold.mockRestore();
        observe.mockRestore();
      }
    });
  },
);
