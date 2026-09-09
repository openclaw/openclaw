import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

it.each([
  "removed",
  "replaced",
  "aborted",
  "released",
  "terminal",
  "rotated",
  "queued",
  "foreign-agent-global-timeout",
  "timeout-during-work-admission",
  "timeout-during-work-admission-fails",
] as const)(
  "keeps prepared-session binding with its exact admission and isolates foreign global timeouts: %s",
  async (closure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const runId = "retained-preparation";
      const timeoutDuringAdmission = closure.startsWith("timeout-during-work-admission");
      const timeoutPersistenceFails = closure === "timeout-during-work-admission-fails";
      const foreignGlobalTimeout = closure === "foreign-agent-global-timeout";
      if (foreignGlobalTimeout) {
        const cfg = getRuntimeConfig();
        setRuntimeConfigSnapshot({
          ...cfg,
          session: { ...cfg.session, scope: "global" },
          agents: { ...cfg.agents, entries: { main: { default: true }, work: {} } },
        });
      }
      const sessionKey = foreignGlobalTimeout ? "global" : "agent:main:binding";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated-session", updatedAt: Date.now() },
      );
      const clone = vi.spyOn(globalThis, "structuredClone");
      const unrelatedCloneCount = () =>
        clone.mock.calls.filter(
          ([entry]) =>
            entry &&
            typeof entry === "object" &&
            "sessionId" in entry &&
            entry.sessionId === "unrelated-session",
        ).length;
      const profile = ensureProfileForEmail("authoring-binding@example.test");
      const client: GatewayClient = {
        connId: "authoring-binding",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const entered = createDeferred<DispatchOptions>();
      const release = createDeferred();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          entered.resolve(options);
          await release.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
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
      const foreignTerminal = createDeferred();
      void foreignTerminal.promise.catch(() => {});
      if (foreignGlobalTimeout) {
        // With global scope these distinct agents share a literal key, not a
        // transcript owner. Work's unfinished timeout must not gate Main's send.
        context.chatAbortControllers.set("foreign-global-timeout", {
          agentId: "work",
          sessionKey: "global",
          sessionId: "work-global-session",
          controller: new AbortController(),
          startedAtMs: Date.now(),
          expiresAtMs: Date.now(),
          abortStopReason: "timeout",
          projectSessionTerminalPersistence: foreignTerminal.promise,
        });
      }
      const workAdmissionReached = createDeferred();
      let releaseAdmission: MockInstance<() => void> | undefined;
      const originalBegin = sessionAdmission.beginSessionWorkAdmission;
      const observeAdmission = vi
        .spyOn(sessionAdmission, "beginSessionWorkAdmission")
        .mockImplementation(async (...args) => {
          const admission = await originalBegin(...args);
          if (timeoutDuringAdmission) {
            releaseAdmission = vi.spyOn(admission, "release");
            // The first timeout check has passed. Real admission's awaited
            // work finishes while the prior run's terminal report is pending.
            context.chatAbortControllers.set("prior-timeout", {
              agentId: "main",
              sessionKey,
              sessionId: "prior-session",
              controller: new AbortController(),
              startedAtMs: Date.now(),
              expiresAtMs: Date.now(),
              abortStopReason: "timeout",
              projectSessionTerminalPersistence: foreignTerminal.promise,
            });
            workAdmissionReached.resolve();
          }
          return admission;
        });
      let handling: Promise<void> | undefined;
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let successor: ReturnType<typeof registerChatAbortController> | undefined;
      let options: DispatchOptions | undefined;
      try {
        const respond = vi.fn();
        const params = {
          sessionKey,
          message: "Keep this user turn in its session",
          idempotencyKey: runId,
          ...(foreignGlobalTimeout ? { agentId: "main" } : {}),
        };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        handling = handleChatSend({
          params,
          req: { type: "req", id: runId, method: "chat.send" },
          respond,
          context,
          client,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        });
        void handling.catch(() => {});
        if (foreignGlobalTimeout) {
          // The foreign promise remains unresolved throughout this bounded check.
          // Without agent matching, real admission blocks and dispatch never starts.
          await vi.waitFor(() => expect(holdDispatch).toHaveBeenCalledOnce(), { timeout: 3_000 });
        }
        if (timeoutDuringAdmission) {
          await workAdmissionReached.promise;
          // Admission reached the race window; give the real handler time to
          // dispatch if it fails to wait on the newly observed terminal owner.
          await sleep(100);
          expect.soft(holdDispatch).not.toHaveBeenCalled();
          expect.soft(respond).not.toHaveBeenCalled();
          if (timeoutPersistenceFails) {
            foreignTerminal.reject(new Error("timeout report commit failed"));
            await handling;
            expect.soft(holdDispatch).not.toHaveBeenCalled();
            expect.soft(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
            expect.soft(releaseAdmission).toHaveBeenCalledOnce();
            expect.soft(context.chatAbortControllers.has(runId)).toBe(false);
            return;
          }
          foreignTerminal.resolve();
        }
        await handling;
        expect(respond).toHaveBeenCalledWith(
          true,
          { runId, status: "started" },
          undefined,
          expect.anything(),
        );
        options = await entered.promise;
        owned = observeDispatch.mock.calls.at(-1)?.[0];
        if (foreignGlobalTimeout) {
          expect(owned?.session.sessionKey).toBe("global");
          expect(owned?.session.selectedAgent.agentId).toBe("main");
          expect(
            context.chatAbortControllers.get("foreign-global-timeout")
              ?.projectSessionTerminalPersistence,
          ).toBe(foreignTerminal.promise);
          return;
        }
        if (timeoutDuringAdmission) {
          expect(holdDispatch).toHaveBeenCalledOnce();
          return;
        }
        const prepared = options.replyOptions?.onSessionPrepared;
        const runStarted = options.replyOptions?.onAgentRunStart;
        if (!owned || !prepared || !runStarted || !owned.skillLibraryAuthoring) {
          throw new Error("chat.send did not hand off its prepared-session callback");
        }
        // Initial resolution needs detached entries; later admission must not clone unrelated rows.
        expect.soft(unrelatedCloneCount()).toBeLessThanOrEqual(1);
        const capability = owned.skillLibraryAuthoring;
        const admittedContext = await namespaceRun.admit("embedded");
        capability.bind(admittedContext);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admittedContext,
          agentId: "main",
          sessionKey,
        });
        const readLibrary = () =>
          withGatewayToolCallerIdentity(caller, () => capability.invoke({ action: "list" }));
        const { admission, userTurn } = owned;
        const original = admission.activeRunAbort.entry;
        expect(original?.sessionId).toBe(runId);
        // This focused test controls preparation; the native WS test proves its real producer.
        await upsertSessionEntryCore(scope, {
          sessionId: "committed-session",
          updatedAt: Date.now(),
        });
        const committed = loadExactSessionEntryReadOnly(scope);
        if (!committed) {
          throw new Error("session writer did not commit");
        }
        const binding = {
          sessionKey,
          sessionId: committed.entry.sessionId,
          storePath: owned.session.storePath,
        };
        prepared(binding);
        prepared(binding);
        prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });
        clone.mockClear();
        runStarted(runId);
        expect.soft(unrelatedCloneCount()).toBe(0);
        await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });

        if (closure === "queued") {
          expect(original?.sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          expect(options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          expect(context.chatQueuedTurns.get(runId)?.sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun();
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
        } else if (closure === "removed" || closure === "replaced") {
          admission.activeRunAbort.cleanup();
          if (closure === "replaced") {
            successor = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionKey,
              sessionId: "successor-session",
              timeoutMs: 60_000,
            });
          }
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          reply = createReplyOperation({
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        expect(original?.sessionId).toBe(binding.sessionId);
        expect(successor?.entry?.sessionId).toBe(
          closure === "replaced" ? "successor-session" : undefined,
        );
        if (closure === "queued") {
          await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
          await expect(readLibrary()).rejects.toThrow();
        }
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          await userTurn.persist();
          expect(
            await loadTranscriptEvents({
              ...scope,
              sessionId: "late-session",
              storePath: binding.storePath,
            }),
          ).toEqual([]);
        }
      } finally {
        foreignTerminal.resolve();
        await handling;
        owned ??= observeDispatch.mock.calls.at(-1)?.[0];
        context.chatAbortControllers.delete("foreign-global-timeout");
        context.chatAbortControllers.delete("prior-timeout");
        namespaceRun.close();
        options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        reply?.complete();
        successor?.cleanup();
        release.resolve();
        if (owned) {
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        observeAdmission.mockRestore();
        releaseAdmission?.mockRestore();
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
        clone.mockRestore();
      }
    });
  },
);
