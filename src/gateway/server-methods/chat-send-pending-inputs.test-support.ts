import path from "node:path";
import type { Static } from "typebox";
import { afterEach, expect, vi } from "vitest";
import type { ChatSendParamsSchema } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock, testState, writeSessionStore } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

export function useBrowserFollowupFixture() {
  const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);
  return async function createBrowserFollowupFixture(
    options: {
      active?: boolean;
      createdActor?: SessionCreatedActor;
      preserveContent?: boolean;
      transientProjectionFailures?: number;
      persistDuringDispatch?: boolean;
    } = {},
  ) {
    const active = options.active !== false;
    const storePath = path.join(temporaryDirs.make("openclaw-chat-custody-"), "sessions.json");
    testState.sessionStorePath = storePath;
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "cloud-session",
      storePath,
    };
    await writeSessionStore({
      entries: {
        main: {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          status: active ? "running" : "done",
          ...(options.createdActor ? { createdActor: options.createdActor } : {}),
        },
        unrelated: {
          sessionId: "unrelated-browser-session",
          updatedAt: Date.now(),
          skillsSnapshot: { prompt: "Unrelated session context. ".repeat(128), skills: [] },
        },
      },
    });
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Keep working on the current task.", timestamp: 1 },
    });
    const activeTranscript = loadTranscriptEventsSync(scope);
    const activeRun = active
      ? createReplyOperation({ ...scope, resetTriggered: false })
      : undefined;
    // Cloud workers expose a running owner but explicitly reject message injection.
    activeRun?.attachBackend({
      kind: "embedded",
      runId: "active-cloud-run",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => false, queueMessage: vi.fn() },
    });
    const approvedContent = "Review the follow-up after the current task.";
    const beforeApprove = vi.fn<(message: PluginHookBeforeMessageWriteEvent["message"]) => void>();
    const registry = getTestPluginRegistry();
    // Hooks disable restart-safe admission, so the idle sibling needs an unhooked fixture.
    if (active) {
      registry.typedHooks.push({
        pluginId: "approved-input-fixture",
        hookName: "before_message_write",
        source: "test",
        handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
          if (message.role !== "user") {
            return undefined;
          }
          beforeApprove(message);
          return {
            message: options.preserveContent ? message : { ...message, content: approvedContent },
          };
        },
      });
    }
    initializeGlobalHookRunner(registry);
    const dispatchRelease = createDeferred();
    const dispatchedRecorder = createDeferred<UserTurnTranscriptRecorder>();
    // Admission, approval, and SQLite remain real; pause only execution after ACK.
    let dispatchAttempts = 0;
    dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
      const { replyOptions } = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
      if (replyOptions?.userTurnTranscriptRecorder) {
        dispatchedRecorder.resolve(replyOptions.userTurnTranscriptRecorder);
      }
      dispatchAttempts += 1;
      if (dispatchAttempts <= (options.transientProjectionFailures ?? 0)) {
        throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
      }
      await dispatchRelease.promise;
      if (options.persistDuringDispatch) {
        if (!replyOptions?.userTurnTranscriptRecorder) {
          throw new Error("Expected dispatch to own the admitted user input");
        }
        await replyOptions.userTurnTranscriptRecorder.persistApproved();
      }
      return {};
    });
    const context = createDirectChatContext({ getRuntimeConfig, chatQueuedTurns: new Map() });
    const client: GatewayClient = {
      connId: "browser-custody-client",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      },
    };
    const params: Static<typeof ChatSendParamsSchema> = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      message: "Raw follow-up awaiting approval.",
      idempotencyKey: "browser-follow-up",
    };
    const send = async (
      respond = vi.fn<RespondFn>(),
      binding?: {
        expectedProfileId?: string;
        signal?: AbortSignal;
        sessionMutationCommitGuard?: () => void;
      },
    ) => {
      const request = {
        req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => true,
      } as const;
      if (binding) {
        await handleGatewayRequest({
          ...request,
          req: { ...request.req, expectedProfileId: binding.expectedProfileId },
          signal: binding.signal,
          sessionMutationCommitGuard: binding.sessionMutationCommitGuard,
          extraHandlers: { "chat.send": handleChatSend },
        });
      } else {
        await handleChatSend(request);
      }
      return respond;
    };
    const finishDispatch = async () => {
      dispatchRelease.resolve();
      activeRun?.complete();
      let settled = false;
      const completion = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      void Promise.resolve(completion).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    };
    return {
      scope,
      context,
      client,
      params,
      approvedContent,
      beforeApprove,
      activeRun,
      activeTranscript,
      send,
      dispatchedRecorder: dispatchedRecorder.promise,
      finishDispatch,
      cleanup: async () => {
        await finishDispatch();
        dispatchInboundMessageMock.mockReset();
      },
    };
  };
}
