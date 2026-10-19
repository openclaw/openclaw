import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import { prepareAgentRequestRouting } from "./agent-turn/agent-request-routing.js";
import { createAgentTurnIo } from "./agent-turn/io.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { normalizeChatSendRequest } from "./server-methods/chat-send-request.js";
import {
  prepareChatSendSession,
  qualifyChatSendSession,
} from "./server-methods/chat-send-session.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const key = "agent:main:pending-stop";
const scope = { agentId: "main", sessionKey: key };
const aborted = { status: "timeout", summary: "aborted" };
const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

async function createPendingOwner(profileName: string) {
  const client = roleClient("view", profileName);
  client.connId = "pending-owner";
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const id = client.authenticatedUserProfile!.profileId;
  const entry = {
    sessionId: "original",
    updatedAt: 1,
    createdActor: { type: "human" as const, source: "profile" as const, id },
  };
  await upsertSessionEntryCore(scope, entry);
  const stop = async (runId: string) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "stop", method: "chat.abort", params: { sessionKey: key, runId } },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "chat.abort": handleChatAbortRequest },
    });
    return respond.mock.calls[0]?.[1];
  };
  return { client, cfg, context, entry, stop };
}

it.each(["current", "replacement"] as const)(
  "does not treat an agent routing reservation as controller admission across %s row state",
  async (target) => {
    await withOpenClawTestState(profileState, async () => {
      const { client, cfg, context, entry, stop } = await createPendingOwner("pending-agent-owner");
      const runId = `pending-agent-${target}`;
      const request = { message: "queued", ...scope, idempotencyKey: runId };
      const routing = { cfg, request, runId, context, agentDedupeKeys: [`agent:${runId}`] };
      const lifecycle = createAgentDedupeLifecycle({
        ...routing,
        suppressVisibleSessionEffects: false,
        ownerConnId: client.connId,
        io: createAgentTurnIo(vi.fn()),
      });
      expect(
        await prepareAgentRequestRouting({
          ...routing,
          respond: vi.fn(),
          isRawModelRun: false,
          reserveDedupe: lifecycle.reserve,
          bindDedupeSessionTarget: lifecycle.bindSessionTarget,
          clearDedupe: lifecycle.clearUnaccepted,
        }),
      ).toBeDefined();
      expect(rpcSourceTesting.size).toBe(0);
      const pending = context.dedupe.get(`agent:${runId}`);
      if (target === "replacement") {
        await upsertSessionEntryCore(scope, { ...entry, sessionId: "replacement" });
      }
      expect(await stop(runId)).toMatchObject({ aborted: false });
      expect(context.dedupe.get(`agent:${runId}`)).toBe(pending);
    });
  },
);

it("keeps a real chat admission abortable while its original session lifecycle is held", async () => {
  await withOpenClawTestState(profileState, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const { client, context, stop } = await createPendingOwner("pending-chat-owner");
    const runId = "pending-chat-admission";
    const request = await normalizeChatSendRequest({
      params: { sessionKey: key, message: "queued", idempotencyKey: runId },
      client,
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const session = await prepareChatSendSession({ request: request.value, client, context });
    if (!session.ok) {
      throw new Error("chat session preparation failed");
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const hold = runSessionMutation({
      scope: session.value.storePath,
      identities: [key, "original"],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const preparedSession = await qualifyChatSendSession(session.value);
    const admission = admitChatSend({
      request: request.value,
      session: preparedSession,
      client,
      context,
      respond: vi.fn(),
    });
    try {
      await vi.waitFor(() =>
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true),
      );
      expect(rpcSourceTesting.has(runId)).toBe(false);
      expect(await stop(runId)).toMatchObject({ aborted: true, runIds: [runId] });
    } finally {
      release.resolve();
      await hold;
      const settled = await admission;
      if (settled.ok) {
        settled.value.cleanupAdmittedRun();
      }
      expect(settled.ok).toBe(false);
      expect(context.dedupe.get(`chat:${runId}`)?.payload).toMatchObject(aborted);
    }
  });
});
