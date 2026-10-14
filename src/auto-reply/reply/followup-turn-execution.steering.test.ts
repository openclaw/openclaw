import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as sandboxRuntime from "../../agents/sandbox/runtime-status.js";
import { bindIngressLifecycleToReplyOptions } from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  observeChannelIngressQueueWrite,
} from "../../channels/message/ingress-drain.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadSessionTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createChatSendMessageInjectionStarter } from "../../gateway/server-methods/chat-send-message-injection.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTypingController as createTypingController,
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { enqueueFollowupRun, isFollowupRunAborted, scheduleFollowupDrain } from "./queue.js";
import { clearFollowupQueueForTest, createQueueTestRun } from "./queue.test-helpers.js";
import {
  collectRuntimeMetadata,
  createOverflowSummaryRetrySource,
} from "./queue/delivery-context.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { retainReplyOperationUntilComplete } from "./reply-run-registry.state.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

const state = getFollowupTurnTestState();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetFollowupTurnTestState);

describe("queued turn steering", () => {
  it.each(["gateway", "collected", "overflow"] as const)(
    "accepts successive Gateway steers into a %s followup after an older source completed",
    async (source) => {
      const root = tempDirs.make("openclaw-followup-steering-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:queued-steering";
      let entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        restartRecoveryTerminalRunIds: ["previous-input"],
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const operation = createReplyOperation({
        sessionKey,
        sessionId: entry.sessionId,
        turnKind: "queued_followup",
        resetTriggered: false,
      });
      await using actor = createReplyRecoveryActorFixture({
        agentId: "main",
        sessionKey,
        storePath,
        operation,
        getSessionId: () => operation.sessionId,
      });
      await actor.bind();
      const turn = createTurn({
        operation,
        session: {
          kind: "session",
          key: sessionKey,
          storePath,
          current: () => entry,
          publish: (next) => {
            if (next) {
              entry = next;
            }
          },
          adopt: (next) => {
            entry = next;
          },
        },
      });
      turn.queued.messageId = "queued-human-input";
      turn.queued.originatingChannel = "webchat";
      turn.queued.originatingTo = "dashboard";
      turn.queued.originatingThreadId = undefined;
      turn.queued.originatingAccountId = undefined;
      turn.queued.originatingChatType = "direct";
      turn.queued.media = undefined;
      turn.queued.run = {
        ...turn.queued.run,
        agentId: "main",
        agentDir: root,
        sessionKey,
        sessionFile: sessionKey,
        workspaceDir: root,
        messageProvider: "webchat",
        chatType: "direct",
        senderIsOwner: false,
      };
      const sourceTurnId = source === "gateway" ? "queued-human-input" : "original-queued-input";
      turn.queued.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: turn.queued.prompt, idempotencyKey: sourceTurnId },
        target: {
          agentId: "main",
          sessionId: entry.sessionId,
          sessionKey,
          storePath,
          sessionEntry: entry,
        },
      });
      if (source !== "gateway") {
        turn.queued.sourceTurnId = sourceTurnId;
      }
      if (source === "collected") {
        turn.queued = {
          ...turn.queued,
          ...collectRuntimeMetadata([
            { ...turn.queued, sourceTurnId: "earlier-collected-input" },
            turn.queued,
          ]),
        };
      } else if (source === "overflow") {
        turn.queued = createOverflowSummaryRetrySource(turn.queued);
      }
      const steeringMessages = [
        "Use the revised request",
        "Keep the new scope",
        "Finish this first",
      ];
      const queueMessage = vi.fn(async (_text: string) => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(readChannelSourceTurnId(params.sessionCtx)).toBe(sourceTurnId);
        operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
        operation.attachBackend({
          kind: "embedded",
          runId: "followup-execution",
          cancel: vi.fn(),
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: (text, _options, assertCurrent) => {
              assertCurrent();
              return queueMessage(text);
            },
          },
        });
        for (const [index, message] of steeringMessages.entries()) {
          const clientRunId = `new-human-input-${index}`;
          const attempt = await createChatSendMessageInjectionStarter({
            target: replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey),
            abortSignal: new AbortController().signal,
            request: {
              p: {
                sessionKey,
                message,
                idempotencyKey: clientRunId,
              },
              rawMessage: message,
              supportsTaskSuggestions: false,
            },
            session: {
              agentId: "main",
              cfg: {},
              entry,
              sessionKey,
              storePath,
              clientRunId,
            },
            turn: {
              ctx: {
                Provider: "webchat",
                Surface: "webchat",
                OriginatingChannel: "webchat",
                OriginatingTo: "dashboard",
                To: "dashboard",
                SessionKey: sessionKey,
                ChatType: "direct",
                SenderId: "user-1",
                Body: message,
              },
              isInternalTextSlashCommandTurn: false,
              replyOptionImages: [],
              replyOptionMedia: [],
            },
            imageOrder: [],
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              target: () => undefined,
            }),
            logGateway: createSubsystemLogger("gateway"),
          })();
          expect(
            attempt,
            "the active followup must retain its admitted source identity",
          ).toBeDefined();
          await expect(attempt!.outcome).resolves.toMatchObject({ status: "accepted" });
        }
        return {
          runId: "followup-execution",
          outcome: { kind: "rejected", payload: { text: "done" } },
        };
      });
      try {
        await executeFollowupTurn({
          turn,
          defaults: {
            typing: createTypingController(),
            typingMode: "never",
            defaultModel: "claude",
          },
          onToolResult: vi.fn(async () => {}),
          onCompactionNoticePayload: vi.fn(async () => {}),
        });
        expect(queueMessage.mock.calls.map(([text]) => text)).toEqual(steeringMessages);
        expect(replyRunRegistry.getSourceTurnId(sessionKey)).toBe(sourceTurnId);
      } finally {
        await turn.restartRecovery?.clear();
      }
    },
  );

  it("accepts same-authority steering while a queued turn runs and rejects changed authority", async () => {
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      turnKind: "queued_followup",
      resetTriggered: false,
    });
    const turn = createTurn({ operation });
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      source: {},
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    turn.queued.operatorAuthority = operatorAuthority;
    const queueMessage = vi.fn(async () => {});
    state.execute.mockImplementation(async () => {
      operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
      operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
      expect(operation.phase).toBe("running");
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget("main");
      expect(target).toBeDefined();
      const overlay = {
        operatorAuthority: createAdmittedRunOperatorAuthority({
          ...operatorAuthority,
          scopes: ["operator.write", "operator.read"],
          source: {},
          signal: new AbortController().signal,
        }),
        originatingChannel: turn.queued.originatingChannel,
        messageProvider: turn.queued.run.messageProvider,
        senderId: "user-2",
        senderIsOwner: false,
        disableTools: false,
        traceAuthorized: false,
      };
      await expect(
        (
          await beginReplyMessageInjectionTarget(target!, "Use the revised request", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: overlay,
          })
        ).outcome,
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        (
          await beginReplyMessageInjectionTarget(target!, "Same permissions from another profile", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: {
              ...overlay,
              operatorAuthority: createAdmittedRunOperatorAuthority({
                ...overlay.operatorAuthority,
                profileId: "maintainer",
              }),
            },
          })
        ).outcome,
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        (
          await beginReplyMessageInjectionTarget(target!, "Change tool permissions", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: { ...overlay, disableTools: true },
          })
        ).outcome,
      ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      for (const incomingOperator of [
        undefined,
        createAdmittedRunOperatorAuthority({ ...operatorAuthority, scopes: ["operator.admin"] }),
      ]) {
        await expect(
          (
            await beginReplyMessageInjectionTarget(
              target!,
              "Different original operator authority",
              {
                isInboundUserMessage: true,
                toolAuthorityOverlay: { ...overlay, operatorAuthority: incomingOperator },
              },
            )
          ).outcome,
        ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      }
      expect(queueMessage).toHaveBeenCalledTimes(2);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    try {
      await executeFollowupTurn({
        turn,
        defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
    } finally {
      operation.complete();
    }
  });
});

describe("queued ingress acceptance", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("lets ingress bound delivery-group preparation failures before queued execution", async () => {
    await withOpenClawTestState({ label: "queued-ingress-group-retry" }, async (testState) => {
      const preparation = vi
        .spyOn(sandboxRuntime, "withSandboxRuntimeStatusesInWorker")
        .mockRejectedValue(new Error("ENOSPC: sandbox status read failed"));
      const queue = createTestIngressQueue(testState.stateDir);
      const failed = observeChannelIngressQueueWrite(queue, "fail", "second-input");
      const key = "agent:main:ingress-group-retry";
      const ingressSignals: AbortSignal[] = [];
      const runFollowup = vi.fn(async () => {});
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 90,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: (event, lifecycle) => {
          ingressSignals.push(lifecycle.abortSignal);
          const run = createQueueTestRun({
            prompt: event.payload.text,
            messageId: event.id,
            originatingChannel: "discord",
            originatingTo: "channel:synthetic-group",
          });
          run.run.agentId = "main";
          run.run.sessionKey = key;
          run.run.gatewayUiCommandTarget = { connId: "synthetic-browser", profileId: "viewer" };
          run.turnAdoptionLifecycle =
            bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
          enqueueFollowupRun(
            key,
            run,
            { mode: "collect", debounceMs: 10, cap: 2, dropPolicy: "summarize" },
            "message-id",
            runFollowup,
            false,
          );
          return { kind: "deferred" };
        },
      });
      try {
        await queue.enqueue("first-input", { text: "First request" }, { laneKey: "first" });
        await queue.enqueue("second-input", { text: "Second request" }, { laneKey: "second" });
        expect(await drain.drainOnce()).toEqual({ started: 2 });
        await drain.waitForIdle();
        scheduleFollowupDrain(key, runFollowup);
        await vi.advanceTimersByTimeAsync(50);
        expect(preparation).toHaveBeenCalled();
        expect(preparation.mock.calls[0]?.[0]).toHaveLength(2);
        expect(runFollowup).not.toHaveBeenCalled();
        expect(ingressSignals.map((signal) => signal.aborted)).toEqual([false, false]);
        await vi.advanceTimersByTimeAsync(60);
        expect(ingressSignals.map((signal) => signal.aborted)).toEqual([true, true]);
        await expect(failed).resolves.toBe(true);
        expect(await queue.listFailed?.()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "first-input", reason: "retry-limit-exceeded" }),
            expect.objectContaining({ id: "second-input", reason: "retry-limit-exceeded" }),
          ]),
        );
      } finally {
        drain.dispose();
        clearFollowupQueueForTest(key);
        preparation.mockRestore();
      }
    });
  });

  it.each(["followup", "collect"] as const)(
    "lets ingress bound repeated preparation failures in %s mode",
    async (mode) => {
      await withOpenClawTestState({ label: "queued-ingress-retry" }, async (testState) => {
        const queue = createTestIngressQueue(testState.stateDir);
        const failed = observeChannelIngressQueueWrite(queue, "fail");
        const key = `agent:main:ingress-retry-${mode}`;
        let ingressSignal: AbortSignal | undefined;
        const runFollowup = vi.fn(async (run: Parameters<typeof isFollowupRunAborted>[0]) => {
          if (!isFollowupRunAborted(run)) {
            throw new Error("ENOSPC: queued preparation failed");
          }
        });
        const drain = createChannelIngressDrain({
          queue,
          adoptionStallTimeoutMs: 90,
          retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
          dispatchClaimedEvent: (_event, lifecycle) => {
            ingressSignal = lifecycle.abortSignal;
            const run = createQueueTestRun({ prompt: "Please answer", messageId: "failed-input" });
            run.turnAdoptionLifecycle =
              bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
            enqueueFollowupRun(
              key,
              run,
              { mode, debounceMs: 10, cap: 2, dropPolicy: "summarize" },
              "message-id",
              runFollowup,
              false,
            );
            scheduleFollowupDrain(key, runFollowup);
            return { kind: "deferred" };
          },
        });
        try {
          await queue.enqueue("failed-input", { text: "Please answer" });
          await drain.drainOnce();
          await drain.waitForIdle();
          await vi.advanceTimersByTimeAsync(110);
          expect(runFollowup).toHaveBeenCalled();
          expect(ingressSignal?.aborted).toBe(true);
          await expect(failed).resolves.toBe(true);
          expect(await queue.listFailed?.()).toMatchObject([
            { id: "failed-input", reason: "retry-limit-exceeded" },
          ]);
        } finally {
          drain.dispose();
          clearFollowupQueueForTest(key);
        }
      });
    },
  );

  it.each(
    ["followup-collect", "followup-overflow"].flatMap((sourceKind) =>
      ["setup-failure", "adoption-timeout", "user-abort"].map((failure) => ({
        sourceKind,
        failure,
      })),
    ),
  )(
    "persists $sourceKind custody before ingress completion and handles $failure without replay",
    async ({ sourceKind, failure }) => {
      await withOpenClawTestState({ label: "queued-ingress-acceptance" }, async (testState) => {
        setRuntimeConfigSnapshot({});
        const target = {
          agentId: "main",
          sessionKey: "agent:main:queued-ingress",
          sessionId: "queued-session",
          storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
        };
        let entry: SessionEntry = { sessionId: target.sessionId, updatedAt: 1 };
        await replaceSessionEntry(target, entry);
        const upstreamAbort = new AbortController();
        const operation = createReplyOperation({
          ...target,
          resetTriggered: false,
          upstreamAbortSignal: upstreamAbort.signal,
        });
        retainReplyOperationUntilComplete(operation);
        await using actor = createReplyRecoveryActorFixture({
          ...target,
          operation,
          getSessionId: () => operation.sessionId,
        });
        await actor.bind();
        const sourceId = `${sourceKind}:queued-session:synthetic-input`;
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: "queued user message", idempotencyKey: sourceId },
          target: { ...target, sessionEntry: entry },
        });
        const turn: AdmittedFollowupTurn = createTurn({
          operation,
          session: {
            kind: "session",
            key: target.sessionKey,
            storePath: target.storePath,
            current: () => entry,
            publish: (next) => {
              if (next) {
                entry = next;
              }
            },
            adopt: (next) => {
              entry = next;
            },
          },
        });
        turn.queued.run = {
          ...turn.queued.run,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          agentDir: testState.agentDir("main"),
          workspaceDir: testState.workspaceDir,
        };
        turn.queued.sourceTurnId = "channel-user:v1:original-inbound";
        turn.queued.userTurnTranscriptRecorder = recorder;
        const execute = getFollowupTurnTestState().execute;
        execute.mockRejectedValue(
          Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
        );
        const queue = createTestIngressQueue(testState.stateDir);
        const timedOut = failure !== "setup-failure";
        const ingressFailed = timedOut
          ? observeChannelIngressQueueWrite(queue, "fail", "source-message")
          : undefined;
        const replies: ReplyPayload[] = [];
        const adopted = vi.fn(async () => {
          expect(recorder.hasPersisted()).toBe(true);
          expect(loadSessionEntry(target)).toMatchObject({
            restartRecoveryDeliveryRunId: "message-1",
            restartRecoveryDeliverySourceRunId: sourceId,
          });
          expect(await loadSessionTranscriptEvents(target)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "user",
                  content: "queued user message",
                  idempotencyKey: sourceId,
                }),
              }),
            ]),
          );
          expect(await queue.listClaims()).toHaveLength(1);
        });
        const drain = createChannelIngressDrain({
          queue,
          adoptionStallTimeoutMs: 90,
          retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycle.abortSignal.addEventListener(
              "abort",
              () => upstreamAbort.abort(lifecycle.abortSignal.reason),
              { once: true },
            );
            turn.queued.abortSignal = lifecycle.abortSignal;
            turn.queued.turnAdoptionLifecycle = bindIngressLifecycleToReplyOptions({
              ...lifecycle,
              onAdopted: async () => {
                await adopted();
                if (timedOut) {
                  if (failure === "user-abort") {
                    expect(operation.abortByUser()).toBe(true);
                  }
                  await vi.advanceTimersByTimeAsync(100);
                  expect(operation.abortSignal.aborted).toBe(true);
                  expect(
                    loadSessionEntry(target)?.restartRecoveryTerminalRunIds ?? [],
                  ).not.toContain(sourceId);
                }
                await lifecycle.onAdopted();
              },
            }).turnAdoptionLifecycle;
            const result = await executeFollowupTurn({
              turn,
              defaults: {
                typing: createTypingController(),
                typingMode: "never",
                defaultModel: "test-model",
              },
              onToolResult: async () => {},
              onCompactionNoticePayload: async () => {},
            });
            if (result.execution.outcome.kind === "rejected") {
              replies.push(result.execution.outcome.payload);
            }
          },
        });
        try {
          await queue.enqueue("source-message", { text: "queued user message" });
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
          expect(adopted).toHaveBeenCalledOnce();
          expect(execute).toHaveBeenCalledTimes(timedOut ? 0 : 1);
          expect(replies).toEqual(
            failure === "user-abort"
              ? []
              : [expect.objectContaining({ text: expect.stringContaining("⚠️") })],
          );
          if (ingressFailed) {
            await expect(ingressFailed).resolves.toBe(true);
          }
          expect(
            await queue.enqueue("source-message", { text: "queued user message" }),
          ).toMatchObject({ kind: timedOut ? "failed" : "completed" });
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          await drain.waitForIdle();
          expect(execute).toHaveBeenCalledTimes(timedOut ? 0 : 1);
          expect(replies).toHaveLength(failure === "user-abort" ? 0 : 1);
        } finally {
          drain.dispose();
          await turn.restartRecovery?.clear();
        }
      });
    },
  );
});
