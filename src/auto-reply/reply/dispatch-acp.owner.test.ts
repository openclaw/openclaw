import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { getAcpSessionManager, testing } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  listSessionPendingInputs,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acp-runtime.js";
import { buildChannelInboundEventContext } from "../../plugin-sdk/channel-inbound.js";
import { resolveNativeCommandSessionTargets } from "../../plugin-sdk/command-auth-native.js";
import {
  getSessionBindingService,
  inspectRuntimeConversationBindingRoute,
} from "../../plugin-sdk/conversation-binding-runtime.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
import { createReplyDispatcher, dispatchInboundMessage } from "../../plugin-sdk/reply-runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { tryDispatchAcpReplyCore } from "./dispatch-acp.js";
import * as processedOutcome from "./dispatch-processed-outcome.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";
import { buildTestCtx } from "./test-ctx.js";

type AcpOwnerScenario = {
  sessionKey: string;
  question: "none" | "confirmed" | "unconfirmed";
  bindingChange: "direct" | "stable" | "removed" | "unavailable" | "owner-changed" | "hint-removed";
  fallbackAgentId?: string;
};

const scenarios: AcpOwnerScenario[] = [
  ...["agent:free-harness:acp:bound", "global"].flatMap((sessionKey) =>
    (["none", "unconfirmed"] as const).map((question) => ({
      sessionKey,
      question,
      bindingChange: "direct" as const,
    })),
  ),
  ...(["none", "unconfirmed"] as const).map((question) => ({
    sessionKey: "agent:free-harness:acp:bound",
    question,
    bindingChange: "removed" as const,
  })),
  ...["agent:free-harness:acp:bound", "global"].map((sessionKey) => ({
    sessionKey,
    question: "confirmed" as const,
    bindingChange: "direct" as const,
  })),
  {
    sessionKey: "agent:free-harness:acp:bound",
    question: "confirmed",
    bindingChange: "unavailable",
  },
  ...["global", "agent:free-harness:ordinary-bound"].flatMap((sessionKey) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey,
      question,
      bindingChange: "removed" as const,
    })),
  ),
  ...(["direct", "stable"] as const).flatMap((bindingChange) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey: "agent:free-harness:ordinary-bound",
      question,
      bindingChange,
    })),
  ),
  ...(["stable", "owner-changed", "hint-removed"] as const).flatMap((bindingChange) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey: "global",
      question,
      bindingChange,
      fallbackAgentId: "main",
    })),
  ),
  ...(["none", "confirmed"] as const).map((question) => ({
    sessionKey: "global",
    question,
    bindingChange: "hint-removed" as const,
    fallbackAgentId: "work",
  })),
];

it.each(scenarios)(
  "preserves ACP target $sessionKey and input ownership (question=$question, binding=$bindingChange, fallback=$fallbackAgentId)",
  async ({ sessionKey, question, bindingChange, fallbackAgentId }) => {
    await withOpenClawTestState({ label: "acp-dispatch-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: {} },
          defaults: { workspace: state.workspaceDir },
        },
        session:
          sessionKey === "agent:free-harness:ordinary-bound"
            ? undefined
            : { scope: "global" as const },
        acp: { backend: "synthetic" },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const agentId = sessionKey === "global" ? "work" : "free-harness";
      const unconfirmedQuestion = question === "unconfirmed";
      const confirmedQuestion = question === "confirmed";
      const pendingQuestion = question !== "none";
      const bound = bindingChange !== "direct";
      const bindingUnavailable = bindingChange === "unavailable";
      const bindingRefused =
        bindingChange === "removed" ||
        bindingUnavailable ||
        bindingChange === "owner-changed" ||
        (bindingChange === "hint-removed" && fallbackAgentId !== agentId);
      let turns = 0;
      let recorder: UserTurnTranscriptRecorder | undefined;
      let sourceCommittedBeforeEffect = false;
      const recordProcessed = vi.fn();
      const markIdle = vi.fn();
      const binding: SessionBindingRecord = {
        bindingId: "acp-owner-route",
        targetSessionKey: sessionKey,
        targetKind: "session",
        status: "active",
        boundAt: 1,
        conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
        ...(sessionKey === "global" ? { metadata: { agentId: "work" } } : {}),
      };
      let currentBinding: SessionBindingRecord | null = binding;
      const adapter: SessionBindingAdapter = {
        channel: "discord",
        accountId: "default",
        listBySession: () => (currentBinding ? [currentBinding] : []),
        resolveByConversation: () => {
          if (bindingUnavailable && !currentBinding) {
            throw new Error("binding owner unavailable");
          }
          return currentBinding;
        },
      };
      if (bound) {
        registerSessionBindingAdapter(adapter);
      }
      const resolveQuestion = vi.fn(async () => {
        sourceCommittedBeforeEffect = recorder?.hasPersisted() === true;
        if (unconfirmedQuestion) {
          throw new Error("resolve response lost");
        }
        return {};
      });
      const claim = pendingQuestion
        ? registerPendingAgentQuestion({
            sessionKey,
            questionId: "ask_77777777777777777777777777777777",
            questions: [
              { id: "choice", header: "Choice", question: "Continue?", isOther: true, options: [] },
            ],
            answer: Promise.resolve({ status: "pending" }),
            gatewayCall: resolveQuestion,
          })
        : undefined;
      claim?.attachRegistration(Promise.resolve());
      registerAcpRuntimeBackend({
        id: "synthetic",
        runtime: {
          ownerAwareSessions: 1,
          async ensureSession(input) {
            return {
              ...input,
              backend: "synthetic",
              runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
            };
          },
          async *runTurn({ handle }) {
            sourceCommittedBeforeEffect = recorder?.hasPersisted() === true;
            turns += 1;
            yield { type: "text_delta", text: `${handle.agentId} reply` };
            yield { type: "done" };
          },
          async cancel() {},
          async close() {},
        },
      });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.text) {
            delivered.push(payload.text);
          }
        },
      });
      try {
        await manager.initializeSession({
          cfg,
          sessionKey,
          agentId,
          agent: "fixture",
          mode: "persistent",
        });
        const entry = loadSessionEntryReadOnly({ agentId, sessionKey });
        if (!entry) {
          throw new Error("ACP fixture did not create its canonical session");
        }
        const target = { agentId, sessionKey, sessionId: entry.sessionId };
        recorder = createUserTurnTranscriptRecorder({
          input: { text: "hello", timestamp: 100, idempotencyKey: "acp-input:user" },
          target: { ...target, sessionEntry: entry, config: cfg },
        });
        expect(
          await recorder.stageApproved?.({ runId: "acp-input", assertCurrent: () => {} }),
        ).toBe(true);
        expect(listSessionPendingInputs(target).items).toHaveLength(1);
        const sourceOwner = fallbackAgentId ?? (sessionKey === "global" ? "work" : "main");
        const sourcePersistence = recorder.persistApproved.bind(recorder);
        const persistApproved = vi
          .spyOn(recorder, "persistApproved")
          .mockImplementation(async () => {
            const persisted = await sourcePersistence();
            if (bindingChange === "removed" || bindingUnavailable) {
              currentBinding = null;
            } else if (bindingChange === "owner-changed") {
              currentBinding = { ...binding, metadata: { agentId: "main" } };
            } else if (bindingChange === "hint-removed") {
              currentBinding = { ...binding, metadata: undefined };
            }
            return persisted;
          });
        const { route } = inspectRuntimeConversationBindingRoute({
          route: {
            agentId: sourceOwner,
            channel: "discord",
            accountId: "default",
            sessionKey: `agent:${sourceOwner}:discord:C123`,
            mainSessionKey: `agent:${sourceOwner}:main`,
            lastRoutePolicy: "session",
            matchedBy: "default",
          },
          inspection: { status: "available", binding },
        });
        if (bound) {
          expect(route.agentId).toBe(agentId);
          expect(route.sessionKey).toBe(sessionKey);
        }
        const result = await tryDispatchAcpReplyCore({
          cfg,
          sessionKey,
          ctx: buildTestCtx({
            AgentId: sourceOwner,
            SessionKey: `agent:${sourceOwner}:main`,
            BodyForAgent: "hello",
            Provider: "webchat",
            Surface: "webchat",
            ...(bound
              ? buildChannelInboundEventContext({
                  channel: "discord",
                  accountId: "default",
                  from: "discord:user:U1",
                  sender: { id: "U1" },
                  conversation: { kind: "channel", id: "C123" },
                  route: { ...route, routeSessionKey: route.sessionKey },
                  reply: { to: "discord:C123" },
                  message: { rawBody: "hello" },
                })
              : {}),
          }),
          dispatcher,
          inboundAudio: false,
          shouldSendToolSummaries: false,
          shouldSendFullToolDetails: false,
          shouldRouteToOriginating: false,
          bypassForCommand: false,
          userTurnTranscriptRecorder: recorder,
          recordProcessed,
          markIdle,
        });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        expect(result).not.toBeNull();
        expect(turns).toBe(pendingQuestion || bindingRefused ? 0 : 1);
        expect(sourceCommittedBeforeEffect).toBe(!bindingRefused);
        expect(persistApproved).toHaveBeenCalledOnce();
        expect(recordProcessed).toHaveBeenCalledOnce();
        expect(markIdle).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(target).items).toEqual([]);
        const transcript = await loadTranscriptEvents(target);
        expect(
          transcript.filter((event) => {
            const transcriptEntry = asOptionalRecord(event);
            const message = asOptionalRecord(transcriptEntry?.message);
            return (
              transcriptEntry?.type === "message" &&
              message?.role === "user" &&
              message.idempotencyKey === "acp-input:user"
            );
          }),
        ).toHaveLength(1);
        if (bindingRefused) {
          expect(resolveQuestion).not.toHaveBeenCalled();
          expect(delivered).toEqual([
            expect.stringContaining(
              bindingUnavailable ? "binding owner unavailable" : "Conversation binding changed",
            ),
          ]);
          expect(result?.queuedFinal).toBe(true);
          expect(recordProcessed).toHaveBeenCalledWith(
            pendingQuestion ? "error" : "completed",
            expect.objectContaining({
              reason: pendingQuestion ? "acp_question_answer_refused" : "acp_error:acp_turn_failed",
            }),
          );
          expect(claim?.isResolving() ?? false).toBe(false);
        } else if (confirmedQuestion) {
          expect(resolveQuestion).toHaveBeenCalledOnce();
          expect(delivered).toEqual([]);
          expect(result?.queuedFinal).toBe(false);
          expect(recordProcessed).toHaveBeenCalledWith("completed", {
            reason: "acp_question_answer",
          });
        } else if (unconfirmedQuestion) {
          expect(delivered).toEqual([expect.stringContaining("confirmation was lost")]);
          expect(result?.queuedFinal).toBe(true);
          expect(recordProcessed).toHaveBeenCalledWith("error", {
            reason: "acp_question_answer_unconfirmed",
            error: expect.stringContaining("not sent again"),
          });
        } else {
          expect(delivered.join("")).toContain(`${agentId} reply`);
        }
        expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toBeUndefined();
      } finally {
        recorder?.finishPendingInput?.("interrupted");
        claim?.dispose();
        if (bound) {
          unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        await disposeAcpSessionManagerInstance(manager, "test-complete");
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("synthetic");
      }
    });
  },
);

const nativeResetTargets = ["acp", "ordinary"] as const;

it.each(nativeResetTargets)("resets the explicit %s target", async (targetKind) => {
  await withOpenClawTestState(
    { label: "public-acp-reset-tail", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const agentId = "work";
      const ordinaryTarget = targetKind === "ordinary";
      const sessionKey = ordinaryTarget
        ? "agent:work:ordinary-reset"
        : "agent:work:acp:public-reset-tail";
      const acpSessionKey = ordinaryTarget ? "agent:work:acp:unrelated-reset" : sessionKey;
      const commandBody = ordinaryTarget ? "/reset" : "/reset continue";
      const backendId = "synthetic-reset-tail";
      const cfg = withFullRuntimeReplyConfig({
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: state.path("main-workspace") },
            work: { workspace: state.path("work-workspace") },
          },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "mock-openai/gpt-5.6-luna" },
            models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
          },
        },
        acp: { enabled: true, dispatch: { enabled: true }, backend: backendId },
        plugins: { enabled: true, allow: ["acpx"], entries: { acpx: { enabled: true } } },
      });
      await state.writeConfig(cfg);
      const registryBuilder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntimeMock(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: "acpx",
        origin: "bundled",
        source: state.path("plugin", "acpx", "index.ts"),
        status: "loaded",
      });
      const api = registryBuilder.createApi(record, { config: cfg });
      registryBuilder.registry.plugins.push(record);
      api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
      setActivePluginRegistry(registryBuilder.registry);
      initializeGlobalHookRunner(registryBuilder.registry);
      let recorder: UserTurnTranscriptRecorder | undefined;
      let initialSessionId: string | undefined;
      let initialLifecycleRevision: string | undefined;
      const freshPreparations: Array<{
        sessionKey: string;
        agentId: string | undefined;
        resetCommitted: boolean;
      }> = [];
      const turns: Array<{
        sessionKey: string;
        agentId: string | undefined;
        text: string;
        inputCommitted: boolean;
        resetCompleted: boolean;
      }> = [];
      registerAcpRuntimeBackend({
        id: backendId,
        runtime: {
          ownerAwareSessions: 1,
          async ensureSession(input) {
            return {
              ...input,
              backend: backendId,
              runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
            };
          },
          async *runTurn({ handle, text }) {
            const entry = loadSessionEntryReadOnly({ agentId, sessionKey: acpSessionKey });
            turns.push({
              sessionKey: handle.sessionKey,
              agentId: handle.agentId,
              text,
              inputCommitted: recorder?.hasPersisted() === true,
              resetCompleted: Boolean(
                entry && entry.lifecycleRevision !== initialLifecycleRevision,
              ),
            });
            yield { type: "text_delta", text: "reset tail completed" };
            yield { type: "done" };
          },
          async prepareFreshSession(input) {
            const entry = loadSessionEntryReadOnly({ agentId, sessionKey: acpSessionKey });
            freshPreparations.push({
              sessionKey: input.sessionKey,
              agentId: input.agentId,
              resetCommitted: Boolean(
                entry && entry.lifecycleRevision !== initialLifecycleRevision,
              ),
            });
          },
          async cancel() {},
          async close() {},
        },
      });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const adapters: SessionBindingAdapter[] = [];
      const model = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
        throw new Error("Native ACP reset tail must not enter the embedded model backend");
      });
      const committed = vi.fn();
      const terminal = vi.spyOn(processedOutcome, "noteDispatchProcessedOutcome");
      const delivered: string[] = [];
      try {
        await manager.initializeSession({
          cfg,
          sessionKey: acpSessionKey,
          agentId,
          agent: "fixture",
          mode: "persistent",
        });
        const initialAcp = loadSessionEntryReadOnly({ agentId, sessionKey: acpSessionKey });
        if (!initialAcp) {
          throw new Error("ACP manager did not create the unrelated reset target");
        }
        if (ordinaryTarget) {
          await replaceSessionEntry(
            { agentId, sessionKey },
            { sessionId: "ordinary-before-reset", updatedAt: Date.now(), systemSent: true },
          );
        }
        const initial = loadSessionEntryReadOnly({ agentId, sessionKey });
        if (!initial) {
          throw new Error("ACP manager did not create the reset target");
        }
        initialSessionId = initial.sessionId;
        initialLifecycleRevision = initial.lifecycleRevision;
        recorder = ordinaryTarget
          ? undefined
          : createUserTurnTranscriptRecorder({
              input: {
                text: "/reset continue",
                timestamp: 100,
                idempotencyKey: "native-reset:unavailable",
              },
              target: () => {
                const entry = loadSessionEntryReadOnly({ agentId, sessionKey });
                return entry
                  ? {
                      agentId,
                      sessionKey,
                      sessionId: entry.sessionId,
                      sessionEntry: entry,
                      config: cfg,
                    }
                  : undefined;
              },
              onOriginalInputCommitted: committed,
            });
        const conversation = {
          channel: "webchat",
          accountId: "default",
          conversationId: "reset-room",
        };
        let sourceBinding: SessionBindingRecord | null = null;
        const makeAdapter = (): SessionBindingAdapter => ({
          channel: "webchat",
          accountId: "default",
          listBySession: (key) => (sourceBinding?.targetSessionKey === key ? [sourceBinding] : []),
          inspectByConversation: () => sourceBinding,
          resolveByConversation: () => sourceBinding,
          resolveByConversationAsync: async () => sourceBinding,
          touchAsync: async () => {},
        });
        const sourceAdapter = makeAdapter();
        if (!ordinaryTarget) {
          sourceAdapter.inspectByConversationAsync = async () => {
            const replacement = makeAdapter();
            adapters.push(replacement);
            registerSessionBindingAdapter(replacement);
            return null;
          };
        }
        adapters.push(sourceAdapter);
        registerSessionBindingAdapter(sourceAdapter);
        const inspection =
          await getSessionBindingService().inspectByConversationAsync(conversation);
        expect(inspection.status).toBe(ordinaryTarget ? "available" : "unavailable");
        const { route } = inspectRuntimeConversationBindingRoute({
          route: {
            agentId: "main",
            channel: "webchat",
            accountId: "default",
            sessionKey: "agent:main:source",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          },
          inspection,
        });
        const targets = resolveNativeCommandSessionTargets({
          agentId: route.agentId,
          sessionPrefix: "webchat:slash",
          userId: "synthetic-user",
          targetSessionKey: sessionKey,
        });
        const buildContext = (native: boolean) =>
          buildChannelInboundEventContext({
            channel: "webchat",
            accountId: "default",
            messageId: `reset-tail-unavailable-${native ? "native" : "ordinary"}`,
            from: "synthetic-user",
            sender: { id: "synthetic-user" },
            conversation: { kind: "direct", id: conversation.conversationId },
            route: {
              ...route,
              routeSessionKey: route.sessionKey,
              dispatchSessionKey: targets.sessionKey,
            },
            reply: { to: conversation.conversationId },
            message: { rawBody: native ? commandBody : "continue" },
            access: { commands: { authorized: true } },
            command: native
              ? { kind: "native", name: "reset", body: commandBody, authorized: true }
              : undefined,
            extra: { CommandTargetSessionKey: targets.commandTargetSessionKey },
          });
        const ordinary = buildContext(false);
        const command = buildContext(true);
        if (ordinaryTarget) {
          sourceBinding = {
            bindingId: "later-unrelated-acp",
            targetSessionKey: acpSessionKey,
            targetKind: "session",
            status: "active",
            boundAt: 2,
            conversation,
          };
        }
        const invoke = async (ctx: typeof command, withRecorder: boolean) => {
          const dispatcher = createReplyDispatcher({
            deliver: async (payload) => {
              if (payload.text) {
                delivered.push(payload.text);
              }
            },
          });
          try {
            return await withPluginRuntimeRegistryScope(registryBuilder.registry, () =>
              dispatchInboundMessage({
                ctx,
                cfg,
                dispatcher,
                replyOptions: withRecorder ? { userTurnTranscriptRecorder: recorder } : undefined,
              }),
            );
          } finally {
            dispatcher.markComplete();
            await dispatcher.waitForIdle();
          }
        };
        await expect(invoke(ordinary, false)).rejects.toMatchObject({
          code: "SESSION_WORK_START_CHANGED",
        });
        expect(turns).toEqual([]);
        expect(freshPreparations).toEqual([]);
        expect(committed).not.toHaveBeenCalled();
        terminal.mockClear();

        await invoke(command, !ordinaryTarget);
        const finalEntry = loadSessionEntryReadOnly({ agentId, sessionKey });
        if (!finalEntry) {
          throw new Error("ACP reset lost the canonical target");
        }
        if (ordinaryTarget) {
          const finalAcp = loadSessionEntryReadOnly({ agentId, sessionKey: acpSessionKey });
          expect({
            normalSessionId: finalEntry.sessionId,
            normalLifecycleRevisionChanged:
              finalEntry.lifecycleRevision !== initialLifecycleRevision,
            unrelatedAcpSessionId: finalAcp?.sessionId,
            unrelatedAcpLifecycle: finalAcp?.lifecycleRevision,
            freshPreparations,
            turns,
            delivered,
          }).toEqual({
            normalSessionId: initialSessionId,
            normalLifecycleRevisionChanged: true,
            unrelatedAcpSessionId: initialAcp.sessionId,
            unrelatedAcpLifecycle: initialAcp.lifecycleRevision,
            freshPreparations: [],
            turns: [],
            delivered: ["✅ Session reset."],
          });
          expect(model).not.toHaveBeenCalled();
          expect(await getSessionBindingService().resolveByConversationAsync(conversation)).toEqual(
            sourceBinding,
          );
          expect(claimInboundDedupe(command).status).toBe("duplicate");
          return;
        }
        expect(finalEntry.sessionId).toBe(initialSessionId);
        expect(finalEntry.lifecycleRevision).not.toBe(initialLifecycleRevision);
        expect(freshPreparations).toEqual(
          expect.arrayContaining([{ sessionKey, agentId, resetCommitted: true }]),
        );
        expect(turns).toEqual([
          {
            sessionKey,
            agentId,
            text: expect.stringContaining("continue"),
            inputCommitted: true,
            resetCompleted: true,
          },
        ]);
        expect(turns[0]?.text).not.toContain("/reset");
        expect(committed).toHaveBeenCalledOnce();
        expect(terminal).toHaveBeenCalledExactlyOnceWith({
          outcome: "completed",
          reason: "acp_dispatch",
        });
        expect(delivered.join("")).toContain("reset tail completed");
        expect(model).not.toHaveBeenCalled();
        const target = { agentId, sessionKey, sessionId: finalEntry.sessionId };
        const transcript = await loadTranscriptEvents(target);
        const messages = transcript.flatMap((event) => {
          const entry = asOptionalRecord(event);
          const message = asOptionalRecord(entry?.message);
          return entry?.type === "message" && message ? [message] : [];
        });
        expect(
          messages.filter(
            (message) =>
              message.role === "user" && message.idempotencyKey === "native-reset:unavailable",
          ),
        ).toHaveLength(1);
        expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
        expect(claimInboundDedupe(command).status).toBe("duplicate");
      } finally {
        recorder?.finishPendingInput?.("interrupted");
        await disposeAcpSessionManagerInstance(manager, "test-complete");
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend(backendId);
        for (const sourceAdapter of adapters.toReversed()) {
          unregisterSessionBindingAdapter({
            channel: sourceAdapter.channel,
            accountId: sourceAdapter.accountId,
            adapter: sourceAdapter,
          });
        }
        await disposePluginRegistryInstances(registryBuilder.registry);
        resetPluginRuntimeStateForTest();
        resetInboundDedupe();
        model.mockRestore();
        terminal.mockRestore();
      }
    },
  );
});
