import path from "node:path";
import type { Static } from "typebox";
import { afterEach, vi } from "vitest";
import type { ChatSendParamsSchema } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  captureSessionTarget,
  captureSessionControllerSettlement,
} from "../../sessions/session-controller.lifecycle.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import { dispatchInboundMessageMock, testState, writeSessionStore } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { releaseGatewaySessionStoreFixture } from "../test/server-sessions-resources.test-helpers.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

export function setClientProfile(
  client: GatewayClient,
  profile: { id: string; updatedAt: number },
  displayName: string | null = null,
) {
  client.authenticatedUserProfile = gatewayProfile(profile.id, displayName, profile.updatedAt);
}

export function setNativeIosClient(client: GatewayClient) {
  client.connect.client = {
    id: "openclaw-ios",
    version: "test",
    platform: "ios",
    mode: "ui",
  };
}

export function useBrowserFollowupFixture() {
  const temporaryDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      await disposeSessionReadContexts();
      // Agent leases retain the per-case Gateway home; release them before its cleanup.
      for (const dir of temporaryDirs.dirs) {
        await releaseGatewaySessionStoreFixture(dir);
      }
      cleanup();
    });
  });
  return async function createBrowserFollowupFixture(
    options: {
      active?: boolean;
      sessionKey?: string;
      createdActor?: SessionCreatedActor;
      sandbox?: "required";
      preserveContent?: boolean;
      deviceIdentity?: boolean;
      transientProjectionFailures?: number;
      persistDuringDispatch?: boolean;
      storage?: "durable" | "memory";
    } = {},
  ) {
    if (options.deviceIdentity !== false) {
      await loadOrCreateProcessDeviceIdentityAsync();
    }
    const active = options.active !== false;
    const storePath = path.join(temporaryDirs.make("openclaw-chat-custody-"), "sessions.json");
    testState.sessionStorePath = storePath;
    const memoryIncognito = options.storage === "memory";
    const scope = {
      agentId: "main",
      sessionKey: memoryIncognito
        ? "agent:main:dashboard:incognito-custody"
        : (options.sessionKey ?? "agent:main:main"),
      sessionId: "cloud-session",
      storePath,
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      status: active ? undefined : ("done" as const),
      ...(options.createdActor ? { createdActor: options.createdActor } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    };
    await writeSessionStore({
      entries: {
        ...(!memoryIncognito ? { [scope.sessionKey]: entry } : {}),
        unrelated: {
          sessionId: "unrelated-browser-session",
          updatedAt: Date.now(),
          skillsSnapshot: { prompt: "Unrelated session context. ".repeat(128), skills: [] },
        },
      },
    });
    const authority = { assertCurrent() {}, authorize() {} };
    const seedTranscript = () =>
      appendTranscriptMessage(scope, {
        message: { role: "user", content: "Keep working on the current task.", timestamp: 1 },
      });
    if (memoryIncognito) {
      scope.storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: scope.agentId });
      await withSessionActorStorage(
        scope,
        {
          create: true,
          lifetime: { assertCurrent() {}, assertReadable() {} },
          authority,
        },
        async () => {
          await upsertSessionEntryCore(scope, { ...entry, incognito: true });
          await seedTranscript();
        },
      );
    } else {
      await seedTranscript();
    }
    const memoryLocation = { agentId: scope.agentId, path: scope.storePath };
    const readTranscript = () => {
      if (!memoryIncognito) {
        return loadTranscriptEventsSync(scope);
      }
      const snapshot = memorySessionActorOwners
        .read(memoryLocation)
        ?.readStorage(
          scope.sessionKey,
          { type: "session.history.hydrate", input: { sessionId: scope.sessionId } },
          authority,
        );
      if (snapshot?.kind !== "full") {
        throw new Error("Expected the memory transcript fixture");
      }
      return snapshot.snapshot.events;
    };
    const activeTranscript = readTranscript();
    const activeRun = active
      ? createReplyOperation({
          ...scope,
          target: captureSessionTarget({
            storeScope: scope.storePath,
            sessionKey: scope.sessionKey,
            incarnation: scope.sessionId,
            agentId: scope.agentId,
          }),
          resetTriggered: false,
        })
      : undefined;
    // Cloud workers expose a running owner but explicitly reject message injection.
    activeRun?.attachBackend({
      kind: "embedded",
      supportsTranscriptCommitWait: true,
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
    // Use a fresh placement store for each fixture's Gateway home.
    const context = createDirectChatContext({
      getRuntimeConfig,
      workerSessionPlacementService: createWorkerSessionPlacementStore(),
    });
    const client: GatewayClient = {
      connId: "browser-custody-client",
      connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"], {
        platform: "web",
      }),
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
      p = params,
      handler = handleChatSend,
    ) => {
      const request = {
        req: { type: "req", id: p.idempotencyKey, method: "chat.send", params: p },
        params: p,
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
          extraHandlers: { "chat.send": handler },
        });
      } else {
        await withPluginRuntimeGatewayRequestScope(
          { context, isWebchatConnect: request.isWebchatConnect },
          () => handler(request),
        );
      }
      return respond;
    };
    const finishDispatch = async () => {
      const completion = captureSessionControllerSettlement({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      dispatchRelease.resolve();
      activeRun?.complete();
      await completion;
    };
    const cleanup = async () => {
      await finishDispatch();
      dispatchInboundMessageMock.mockReset();
      if (memoryIncognito) {
        memorySessionActorOwners.closeSession(memoryLocation, scope.sessionKey);
      }
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
      readTranscript,
      send,
      dispatchedRecorder: dispatchedRecorder.promise,
      releaseDispatch: () => dispatchRelease.resolve(),
      finishDispatch,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  };
}
