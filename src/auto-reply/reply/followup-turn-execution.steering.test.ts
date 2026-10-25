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
import { createRpcSourceForTest } from "../../gateway/test-helpers.rpc-source.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.identity.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import { createQueueTestRun, rejectQueuePreparation } from "./queue.test-helpers.js";
import { completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { clearFollowupQueue } from "./queue/state.js";
import { isFollowupRunAborted } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
import { createMockTypingController } from "./test-helpers.js";

const state = getFollowupTurnTestState();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetFollowupTurnTestState);

function executeTurn(turn: AdmittedFollowupTurn, defaultModel = "claude") {
  return executeFollowupTurn({
    turn,
    defaults: { typing: createMockTypingController(), typingMode: "never", defaultModel },
    onToolResult: vi.fn(async () => {}),
    onCompactionNoticePayload: vi.fn(async () => {}),
  });
}

function sessionState(key: string, storePath: string, initial: SessionEntry) {
  let entry = initial;
  return {
    kind: "session" as const,
    key,
    storePath,
    current: () => entry,
    publish: (next: SessionEntry | undefined) => {
      if (next) {
        entry = next;
      }
    },
  };
}

async function settleTurn(turn: AdmittedFollowupTurn) {
  if (turn.queued.controllerInput) {
    completeFollowupRunLifecycle(turn.queued);
    await Promise.allSettled([turn.queued.controllerInput.settlement.promise]);
  }
}

describe("queued turn steering", () => {
  it.each(["gateway", "recorded"] as const)(
    "accepts successive Gateway steers into a %s followup after an older source completed",
    async (source) => {
      const root = tempDirs.make("openclaw-followup-steering-");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:queued-steering",
        sessionId: "session",
        storePath: path.join(root, "sessions.json"),
      };
      const { storePath, sessionKey } = target;
      const entry: SessionEntry = {
        sessionId: target.sessionId,
        updatedAt: 1,
        restartRecoveryTerminalRunIds: ["previous-input"],
      };
      await replaceSessionEntry(target, entry);
      const operation = createReplyOperation({
        ...target,
        turnKind: "queued_followup",
        resetTriggered: false,
      });
      await using actor = createReplyRecoveryActorFixture({
        ...target,
        operation,
        getSessionId: () => operation.sessionId,
      });
      await actor.bind();
      const turn = createTurn({
        operation,
        session: sessionState(sessionKey, storePath, entry),
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
        target: { ...target, sessionEntry: entry },
      });
      if (source !== "gateway") {
        turn.queued.sourceTurnId = sourceTurnId;
      }
      const steeringMessages = [
        "Use the revised request",
        "Keep the new scope",
        "Finish this first",
      ];
      const runId = "followup-execution";
      const queueMessage = vi.fn(async (_text: string) => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(readChannelSourceTurnId(params.sessionCtx)).toBe(sourceTurnId);
        operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
        operation.attachBackend({
          kind: "embedded",
          supportsTranscriptCommitWait: true,
          runId,
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
            sourceRef: createRpcSourceForTest(
              {},
              {
                runId: clientRunId,
                storeScope: storePath,
                sessionKey,
                sessionId: entry.sessionId,
                agentId: "main",
              },
            ),
            target: captureCurrentReplyMessageInjectionTarget(sessionKey),
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
              ...target,
              resolvedSessionModel: { provider: "anthropic", model: "claude" },
              cfg: {},
              entry: turn.session.current(),
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
        return { runId, outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      try {
        await executeTurn(turn);
        expect(queueMessage.mock.calls.map(([text]) => text)).toEqual(steeringMessages);
        expect(getSessionControllerEntryForOperation(operation).sourceTurnId).toBe(sourceTurnId);
      } finally {
        await settleTurn(turn);
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
      operation.attachBackend({
        kind: "embedded",
        supportsTranscriptCommitWait: true,
        cancel: vi.fn(),
        queueMessage,
      });
      expect(operation.phase).toBe("running");
      const target = captureCurrentReplyMessageInjectionTarget("main");
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
      const inject = async (
        text: string,
        toolAuthorityOverlay: ReplyToolAuthorityOverlay = overlay,
      ) =>
        (
          await beginReplyMessageInjectionTarget(target!, text, {
            isInboundUserMessage: true,
            toolAuthorityOverlay,
          })
        ).outcome;
      const reject = (text: string, changes: Partial<ReplyToolAuthorityOverlay>) =>
        expect(inject(text, { ...overlay, ...changes })).resolves.toMatchObject({
          status: "rejected",
          reason: "tool_authority_mismatch",
        });
      await expect(inject("Use the revised request")).resolves.toMatchObject({
        status: "accepted",
      });
      await reject("Change tool permissions", { disableTools: true });
      await reject("Missing original operator authority", { operatorAuthority: undefined });
      expect(queueMessage).toHaveBeenCalledOnce();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    try {
      await executeTurn(turn);
    } finally {
      await settleTurn(turn);
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

  it("bounds preparation failures while preserving exclusive ingress", async () => {
    await withOpenClawTestState({ label: "queued-ingress-retry" }, async (testState) => {
      const preparation = vi
        .spyOn(sandboxRuntime, "withSandboxRuntimeStatusesInWorker")
        .mockRejectedValue(new Error("ENOSPC: sandbox status read failed"));
      const queue = createTestIngressQueue(testState.stateDir);
      const failed = observeChannelIngressQueueWrite(queue, "fail", "second-input");
      const key = "agent:main:ingress-group-retry";
      const signals: AbortSignal[] = [];
      const selectedGroups: string[][] = [];
      const runFollowup = vi.fn(async (run: FollowupRun) => {
        if (isFollowupRunAborted(run)) {
          return;
        }
        const claim = run.controllerClaim ?? run.controllerInput?.claim;
        selectedGroups.push(claim?.sources.map((source) => source.prompt) ?? []);
        rejectQueuePreparation(run, new Error("ENOSPC: queued preparation failed"));
      });
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 90,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: (event, lifecycle) => {
          signals.push(lifecycle.abortSignal);
          const run = createQueueTestRun(
            {
              prompt: event.payload.text,
              messageId: event.id,
              originatingChannel: "discord",
              originatingTo: "channel:synthetic-group",
            },
            {
              agentId: "main",
              sessionKey: key,
              gatewayUiCommandTarget: { connId: "synthetic-browser", profileId: "viewer" },
            },
          );
          run.turnAdoptionLifecycle =
            bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
          run.abortSignal = lifecycle.abortSignal;
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
        expect(preparation).not.toHaveBeenCalled();
        expect(selectedGroups.length).toBeGreaterThan(0);
        for (const sources of selectedGroups) {
          expect(sources).toEqual(["First request"]);
        }
        expect(await queue.listClaims()).toHaveLength(2);
        expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
        await vi.advanceTimersByTimeAsync(60);
        expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
        expect(selectedGroups).toContainEqual(["Second request"]);
        // The waiting input keeps its heartbeat until its own preparation fails.
        await vi.advanceTimersByTimeAsync(90);
        expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
        await expect(failed).resolves.toBe(true);
        const failures = await queue.listFailed?.();
        for (const id of ["first-input", "second-input"]) {
          expect(failures).toContainEqual(
            expect.objectContaining({ id, reason: "retry-limit-exceeded" }),
          );
        }
      } finally {
        drain.dispose();
        clearFollowupQueue(key);
        preparation.mockRestore();
      }
    });
  });

  it.each(["setup-failure", "adoption-timeout", "user-abort"])(
    "persists custody before ingress completion and handles %s without replay",
    async (failure) => {
      await withOpenClawTestState({ label: "queued-ingress-acceptance" }, async (testState) => {
        setRuntimeConfigSnapshot({});
        const target = {
          agentId: "main",
          sessionKey: "agent:main:queued-ingress",
          sessionId: "queued-session",
          storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
        };
        const entry: SessionEntry = { sessionId: target.sessionId, updatedAt: 1 };
        await replaceSessionEntry(target, entry);
        const upstreamAbort = new AbortController();
        const operation = createReplyOperation({
          ...target,
          resetTriggered: false,
          upstreamAbortSignal: upstreamAbort.signal,
        });
        await using actor = createReplyRecoveryActorFixture({
          ...target,
          operation,
          getSessionId: () => operation.sessionId,
        });
        await actor.bind();
        const sourceId = "followup-collect:queued-session:synthetic-input";
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: "queued user message", idempotencyKey: sourceId },
          target: { ...target, sessionEntry: entry },
        });
        const turn: AdmittedFollowupTurn = createTurn({
          operation,
          session: sessionState(target.sessionKey, target.storePath, entry),
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
          expect(await loadSessionTranscriptEvents(target)).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "user",
                content: "queued user message",
                idempotencyKey: sourceId,
              }),
            }),
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
            const result = await executeTurn(turn, "test-model");
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
          await settleTurn(turn);
          await turn.restartRecovery?.clear();
        }
      });
    },
  );
});
