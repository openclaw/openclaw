import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { captureMethodCall } from "../../../test/helpers/capture-method-call.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees, ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { clearFollowupQueueForTest } from "../../auto-reply/reply/queue.test-helpers.js";
import { getFollowupQueueDepth } from "../../auto-reply/reply/queue/enqueue.js";
import {
  replyRunRegistry,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
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
    const realDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
      "../../auto-reply/dispatch.js",
    );
    const realReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
      "../../auto-reply/reply/get-reply.js",
    );
    const workspace = await initializeRepository(tempDirs.make("openclaw-prestart-steer-"), "repo");
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const preparingWorkspace = createDeferred();
    const releaseWorkspace = createDeferred();
    const releaseInitialRun = createDeferred();
    const releaseInitialBackend = createDeferred();
    const initialRuntimeStarted = createDeferred();
    const inputQueued = createDeferred();
    const steerAccepted = createDeferred();
    const steerDeclined = createDeferred();
    const releaseSteerCommit = createDeferred();
    const steerTerminal = createDeferred();
    const followupStarted = createDeferred();
    const releaseFollowup = createDeferred();
    const queuedSettled = createDeferred();
    const steerRunId = "prestart-steer-input";
    const steerText = "Steer: include the regression proof.";
    const consumed: Array<{ runId: string; text: string }> = [];
    const terminalBeforeConsumption: boolean[] = [];
    let initialOperation: ReplyOperation | undefined;
    let sessionKey: string | undefined;
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const logGateway = { ...createSubsystemLogger("test/gateway"), info: vi.fn() };
    const context = {
      logGateway,
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
          (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
        ) {
          terminalBeforeConsumption.push(consumed.length === 0);
          steerTerminal.resolve();
        }
      }),
    };
    const requestOptions = { ...controlUiClient, context };
    const createWorktree = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
    const worktreeSpy = vi
      .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
      .mockImplementation(async function (this: ManagedWorktreeService, params) {
        preparingWorkspace.resolve();
        await releaseWorkspace.promise;
        return createWorktree(this, params);
      });
    runtime.execute.mockImplementation(async ({ followupRun, opts, replyOperation }) => {
      const runId = expectDefined(opts?.runId, "runtime run ID");
      if (!initialOperation) {
        initialOperation = expectDefined(replyOperation, "initial reply admission");
        initialRuntimeStarted.resolve();
        await releaseInitialBackend.promise;
        initialOperation.attachBackend({
          kind: "embedded",
          runId,
          toolAuthorityFingerprint: initialOperation.bindToolAuthorityRoute(followupRun.run),
          cancel: () => {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => {
              if (injection === "unavailable") {
                steerDeclined.resolve();
              }
              return injection !== "unavailable";
            },
            queueMessage: async (text, options, assertCurrent) => {
              assertCurrent();
              if (injection === "rejected") {
                steerDeclined.resolve();
                throw new Error("Runtime declined late steering");
              }
              options?.onQueueAccepted?.(true);
              steerAccepted.resolve();
              await releaseSteerCommit.promise;
              assertCurrent();
              await options?.userTurnTranscriptRecorder?.persistApproved();
              consumed.push({ runId, text });
            },
          },
        });
        await releaseInitialRun.promise;
      } else {
        opts?.onAgentRunStart?.(runId);
        await expectDefined(
          followupRun.userTurnTranscriptRecorder,
          "queued input",
        ).persistApproved();
        consumed.push({ runId, text: followupRun.prompt });
        followupStarted.resolve();
        await releaseFollowup.promise;
      }
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
    // Observe custody without replacing dispatch, reply preparation, or queue policy.
    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as Parameters<typeof dispatchInboundMessage>[0];
      if (params.replyOptions?.runId === steerRunId) {
        const lifecycle = expectDefined(params.replyOptions.turnAdoptionLifecycle, "input custody");
        const onDeferred = expectDefined(lifecycle.onDeferred, "queued input admission");
        lifecycle.onDeferred = () => {
          const admitted = onDeferred();
          inputQueued.resolve();
          return admitted;
        };
        const onSettled = lifecycle.onSettled;
        lifecycle.onSettled = () => {
          onSettled?.();
          queuedSettled.resolve();
        };
      }
      return realDispatch.dispatchInboundMessage({
        ...params,
        replyResolver: realReply.getReplyFromConfig,
      });
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
      const steerEntry = expectDefined(
        context.chatAbortControllers.get(steerRunId),
        "steer source registration",
      );
      expect(terminalBeforeConsumption).toEqual([]);
      clock = 15_800;
      releaseWorkspace.resolve();
      await withinTest(inputQueued.promise, signal);
      // Steering can park before reply preparation reaches the runtime.
      await withinTest(initialRuntimeStarted.promise, signal);
      expect(context.chatQueuedTurns.has(steerRunId)).toBe(true);
      expect(initialOperation?.phase).toBe("running");
      expect(consumed).toEqual([]);
      releaseInitialBackend.resolve();
      if (injection === "accepted") {
        await withinTest(steerAccepted.promise, signal);
        expect(terminalBeforeConsumption).toEqual([]);
        expect(consumed).toEqual([]);
        releaseSteerCommit.resolve();
        await withinTest(steerTerminal.promise, signal);
        expect(consumed).toEqual([
          { runId: createdSession.runId, text: expect.stringContaining(steerText) },
        ]);
        expect(terminalBeforeConsumption).toEqual([false]);
        expect(runtime.execute).toHaveBeenCalledOnce();
      } else {
        await withinTest(steerDeclined.promise, signal);
        expect(
          await waitForChatAbortControllerRemoval({
            entries: context.chatAbortControllers,
            targets: [{ runId: steerRunId, entry: steerEntry }],
            timeoutMs: null,
            signal,
          }),
        ).toBe(true);
        expect(terminalBeforeConsumption).toEqual([]);
        expect(consumed).toEqual([]);
        expect(context.chatQueuedTurns.has(steerRunId)).toBe(true);
        expectDefined(initialOperation, "initial run owner").complete();
        releaseInitialRun.resolve();
        await withinTest(followupStarted.promise, signal);
        expect(runtime.execute).toHaveBeenCalledTimes(2);
        expect(consumed).toEqual([
          { runId: expect.any(String), text: expect.stringContaining(steerText) },
        ]);
        expect(consumed[0]?.runId).not.toBe(createdSession.runId);
        expect(consumed[0]?.runId).not.toBe(steerRunId);
        expect(terminalBeforeConsumption).toEqual([]);
        releaseFollowup.resolve();
        await withinTest(queuedSettled.promise, signal);
        expect(terminalBeforeConsumption).toEqual([false]);
        expect(context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId: steerRunId, state: "final" }),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );
      }
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(
        logGateway.info.mock.calls.filter(([message]) => message.startsWith("slow chat send")),
      ).toEqual([
        [
          expect.stringContaining(
            `slow chat send 15800ms stage=${injection === "accepted" ? "steer" : "queued"} ack=0ms`,
          ),
        ],
        ...(injection === "accepted"
          ? []
          : [[expect.stringContaining("slow chat send 15800ms stage=startup ack=0ms")]]),
      ]);
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
      releaseInitialBackend.resolve();
      releaseSteerCommit.resolve();
      releaseFollowup.resolve();
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
        const owned = await managedWorktrees.findLiveByOwner("session", sessionKey);
        if (owned) {
          await managedWorktrees.remove({
            id: owned.id,
            reason: "test-cleanup",
            allowSnapshotLoss: true,
          });
        }
      }
      testState.agentConfig = undefined;
      now.mockRestore();
    }
  },
);
