import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { runReplyAgent } from "../../auto-reply/reply/agent-runner-run.js";
import {
  clearFollowupQueueForTest,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { getFollowupQueueDepth } from "../../auto-reply/reply/queue/enqueue.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  controlUiClient,
  initializeRepository,
} from "../server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));

vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

test.for(["accepted", "unavailable", "rejected"] as const)(
  "preserves a prestart steer through workspace preparation when late injection is %s",
  async (injection, { signal }) => {
    const workspace = await initializeRepository(tempDirs.make("openclaw-prestart-steer-"), "repo");
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const preparingWorkspace = createDeferred();
    const releaseWorkspace = createDeferred();
    const releaseInitialRun = createDeferred();
    const initialRunStarted = createDeferred();
    const steerAccepted = createDeferred();
    const releaseSteerCommit = createDeferred();
    const steerTerminal = createDeferred();
    const queuedSettled = createDeferred();
    const steerRunId = "prestart-steer-input";
    const steerText = "Steer: include the regression proof.";
    const consumed: Array<{ runId: string; text: string }> = [];
    const terminalBeforeConsumption: boolean[] = [];
    let initialOperation: ReplyOperation | undefined;
    let sessionKey: string | undefined;
    const context = {
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      chatQueuedTurns: new Map(),
      broadcast: vi.fn((event: string, payload: unknown) => {
        if (
          event === "chat" &&
          typeof payload === "object" &&
          payload !== null &&
          "runId" in payload &&
          payload.runId === steerRunId &&
          "state" in payload &&
          payload.state !== "delta"
        ) {
          terminalBeforeConsumption.push(consumed.length === 0);
          steerTerminal.resolve();
        }
      }),
    };
    const requestOptions = { ...controlUiClient, context };
    const createWorktree = managedWorktrees.createWithOutcome.bind(managedWorktrees);
    const worktreeSpy = vi
      .spyOn(managedWorktrees, "createWithOutcome")
      .mockImplementation(async (params) => {
        preparingWorkspace.resolve();
        await releaseWorkspace.promise;
        return createWorktree(params);
      });
    runtime.execute.mockImplementation(async ({ followupRun, opts }) => {
      const runId = expectDefined(opts?.runId, "followup run ID");
      await expectDefined(followupRun.userTurnTranscriptRecorder, "queued input").persistApproved();
      consumed.push({ runId, text: followupRun.prompt });
      return {
        runId,
        outcome: {
          kind: "settled",
          status: "ok",
          result: {
            payloads: [{ text: "Included the regression proof." }],
            meta: { durationMs: 0 },
          },
          resolved: { provider: "openai", model: "gpt-test" },
          fallback: { exhausted: false, attempts: [] },
          autoCompactionCount: 0,
          didLogHeartbeatStrip: false,
        },
      };
    });
    // Keep handler admission, workspace preparation, steering, queue draining,
    // and transcript persistence real; supply only prepared model/runtime facts.
    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const { ctx, cfg, replyOptions } = raw as Parameters<typeof dispatchInboundMessage>[0];
      const opts = expectDefined(replyOptions, "prepared reply options");
      const key = expectDefined(ctx.SessionKey, "prepared session key");
      const entry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath }),
        "created session",
      );
      const base = createQueueTestRun({
        prompt: expectDefined(ctx.BodyForAgent, "prepared prompt"),
        messageId: ctx.MessageSid,
        originatingChannel: "webchat",
      });
      const followup: FollowupRun = {
        ...base,
        operatorAuthority: opts?.operatorAuthority,
        abortSignal: opts?.abortSignal,
        turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
        userTurnTranscriptRecorder: opts?.userTurnTranscriptRecorder,
        queuedFollowupReplyDisposition: {
          kind: "deliver",
          deliver: expectDefined(opts.onQueuedFollowupReplyBatch, "queued delivery owner"),
        },
        run: {
          ...base.run,
          config: cfg,
          agentId: "main",
          sessionId: entry.sessionId,
          sessionKey: key,
          sessionFile: entry.sessionFile ?? `${workspace}/session.jsonl`,
          workspaceDir: entry.spawnedCwd ?? workspace,
          cwd: entry.spawnedCwd,
          messageProvider: "webchat",
          chatType: "direct",
          senderIsOwner: true,
        },
      };
      if (opts?.runId !== steerRunId) {
        const initialRunId = expectDefined(opts.runId, "initial run ID");
        await opts?.userTurnTranscriptRecorder?.persistApproved();
        initialOperation = createReplyOperation({
          agentId: "main",
          sessionKey: key,
          sessionId: entry.sessionId,
          resetTriggered: false,
        });
        initialOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followup));
        const fingerprint = initialOperation.bindToolAuthorityRoute(followup.run);
        initialOperation.attachBackend({
          kind: "embedded",
          runId: initialRunId,
          toolAuthorityFingerprint: fingerprint,
          cancel: () => {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => injection !== "unavailable",
            queueMessage: async (text, options, assertCurrent) => {
              assertCurrent();
              if (injection === "rejected") {
                throw new Error("Runtime declined late steering");
              }
              options?.onQueueAccepted?.(true);
              steerAccepted.resolve();
              await releaseSteerCommit.promise;
              assertCurrent();
              await options?.userTurnTranscriptRecorder?.persistApproved();
              consumed.push({ runId: initialRunId, text });
            },
          },
        });
        initialOperation.setPhase("running");
        initialRunStarted.resolve();
        await releaseInitialRun.promise;
      } else {
        await initialRunStarted.promise;
        const lifecycle = expectDefined(opts.turnAdoptionLifecycle, "queued input lifecycle");
        const onSettled = lifecycle.onSettled;
        lifecycle.onSettled = () => {
          onSettled?.();
          queuedSettled.resolve();
        };
        await runReplyAgent({
          commandBody: followup.prompt,
          followupRun: followup,
          queueKey: key,
          resolvedQueue: { mode: "steer", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
          shouldSteer: true,
          shouldFollowup: true,
          isActive: true,
          isRunActive: () => replyRunRegistry.isActive(key),
          opts,
          typing: createTypingController({}),
          sessionEntry: entry,
          sessionStore: { [key]: entry },
          sessionKey: key,
          storePath,
          defaultModel: "gpt-test",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "text_end",
          sessionCtx: ctx,
          shouldInjectGroupIntro: false,
          typingMode: "never",
        });
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    try {
      const created = await directSessionReq<{ key: string; runId: string }>(
        "sessions.create",
        {
          agentId: "main",
          cwd: workspace,
          worktree: true,
          worktreeName: "prestart",
          message: "Implement the original task.",
        },
        requestOptions,
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const createdSession = expectDefined(created.payload, "created session response");
      sessionKey = createdSession.key;
      await withinTest(preparingWorkspace.promise, signal);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.pendingWorktree,
      ).toBeDefined();
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      const sent = await directSessionReq<{ runId: string; status: string }>(
        "chat.send",
        {
          agentId: "main",
          sessionKey,
          message: steerText,
          queueMode: "steer",
          idempotencyKey: steerRunId,
        },
        requestOptions,
      );
      expect(sent).toMatchObject({ ok: true, payload: { runId: steerRunId, status: "started" } });
      expect(terminalBeforeConsumption).toEqual([]);
      releaseWorkspace.resolve();
      await withinTest(Promise.race([steerAccepted.promise, steerTerminal.promise]), signal);
      if (injection === "accepted") {
        expect(terminalBeforeConsumption).toEqual([]);
        expect(consumed).toEqual([]);
        releaseSteerCommit.resolve();
        await withinTest(steerTerminal.promise, signal);
        expect(consumed).toEqual([
          { runId: createdSession.runId, text: expect.stringContaining(steerText) },
        ]);
        expect(terminalBeforeConsumption).toEqual([false]);
        expect(runtime.execute).not.toHaveBeenCalled();
      } else {
        // Rejected steering retains the existing source-completion contract;
        // queue custody must still deliver the input after the first run ends.
        expect(terminalBeforeConsumption).toEqual([true]);
        expect(consumed).toEqual([]);
        expect(context.chatQueuedTurns.has(steerRunId)).toBe(true);
        expectDefined(initialOperation, "initial run owner").complete();
        releaseInitialRun.resolve();
        await withinTest(queuedSettled.promise, signal);
        expect(runtime.execute).toHaveBeenCalledOnce();
        expect(consumed).toEqual([
          { runId: expect.any(String), text: expect.stringContaining(steerText) },
        ]);
        expect(consumed[0]?.runId).not.toBe(createdSession.runId);
        expect(consumed[0]?.runId).not.toBe(steerRunId);
      }
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      const entry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey, storePath }),
        "session",
      );
      const messages = loadTranscriptEventsSync({
        agentId: "main",
        sessionKey,
        sessionId: entry.sessionId,
        storePath,
      });
      expect(
        messages.filter(
          (event) =>
            isRecord(event) &&
            isRecord(event.message) &&
            event.message.role === "user" &&
            extractTextFromChatContent(event.message.content) === steerText,
        ),
      ).toHaveLength(1);
    } finally {
      const released = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [sessionKey],
      });
      releaseWorkspace.resolve();
      releaseSteerCommit.resolve();
      if (sessionKey) {
        clearFollowupQueueForTest(sessionKey);
      }
      initialOperation?.complete();
      releaseInitialRun.resolve();
      await released;
      worktreeSpy.mockRestore();
      dispatchInboundMessageMock.mockReset();
      runtime.execute.mockReset();
      if (sessionKey) {
        const owned = managedWorktrees.findLiveByOwner("session", sessionKey);
        if (owned) {
          await managedWorktrees.remove({
            id: owned.id,
            reason: "test-cleanup",
            allowSnapshotLoss: true,
          });
        }
      }
      testState.agentConfig = undefined;
    }
  },
);
