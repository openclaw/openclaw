import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { captureMethodCall } from "../../../test/helpers/capture-method-call.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import {
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { getFollowupQueueDepth } from "../../auto-reply/reply/queue/enqueue.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  captureSessionTarget,
  captureSessionControllerSettlement,
} from "../../sessions/session-controller.lifecycle.js";
import {
  isRpcSourceQueued,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { dispatchInboundMessageMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { loadRealChatDispatch, successfulChatTurn } from "./chat-send-authority.test-support.js";
import type { GatewayClient } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));
registerAgentSessionLoopTestLifecycle();

vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

function createRequestClients() {
  const profile = ensureGatewayOwnerProfile("Gateway Owner");
  const client = {
    ...createOperatorWsClient({
      connId: "prestart-owner",
      clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
      scopes: ["operator.write"],
    }),
    usesSharedGatewayAuth: true,
    authenticatedUserProfile: gatewayProfile(profile.id, profile.displayName, profile.updatedAt),
    internal: {
      authenticatedOperator: true as const,
      operatorRoleActor: { kind: "system" as const },
    },
  };
  const clients = new Set<GatewayClient & { connId: string }>([client]);
  return {
    client,
    clients,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((entry) => !filter || filter(entry)).map((entry) => entry.connId),
      ),
  };
}

function expectSingleUserInput(storePath: string, sessionKey: string, text: string) {
  const scope = { agentId: "main", sessionKey, storePath };
  const entry = expectDefined(loadSessionEntry(scope), "session");
  const events = loadTranscriptEventsSync({ ...scope, sessionId: entry.sessionId });
  expect(
    events.filter(
      (event) =>
        isRecord(event) &&
        isRecord(event.message) &&
        event.message.role === "user" &&
        extractTextFromChatContent(event.message.content) === text,
    ),
  ).toHaveLength(1);
}

function clearFixture(storePath: string, sessionKey?: string) {
  if (sessionKey) {
    clearSessionQueues(
      [sessionKey],
      captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" }),
    );
  }
}

function resetFixture(clients: Set<GatewayClient & { connId: string }>) {
  clients.clear();
  dispatchInboundMessageMock.mockReset();
  runtime.execute.mockReset();
}

test.for(["accepted", "unavailable", "rejected", "withdrawn"] as const)(
  "preserves a prestart steer through workspace preparation when late injection is %s",
  async (injection, { signal }) => {
    const realDispatch = await loadRealChatDispatch();
    const workspace = await initializeRepository(tempDirs.make("openclaw-prestart-steer-"), "repo");
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const preparing = createDeferred();
    const releaseWorkspace = createDeferred();
    const releaseRun = createDeferred();
    const attachBackend = createDeferred();
    const runtimeStarted = createDeferred();
    const inputQueued = createDeferred();
    const steerAccepted = createDeferred();
    const steerDeclined = createDeferred();
    const releaseSteerCommit = createDeferred();
    const steerTerminal = createDeferred();
    const followupStarted = createDeferred();
    const releaseFollowup = createDeferred();
    const queuedSettled = createDeferred();
    const dispatchSettled = createDeferred();
    const steeringDispatchFinished = createDeferred();
    const steerRunId = "prestart-steer-input";
    const steerText = "Steer: include the regression proof.";
    const consumed: Array<{ runId: string; text: string }> = [];
    const earlyTerminals: boolean[] = [];
    const expectUnconsumed = () => {
      expect(consumed).toEqual([]);
      expect(earlyTerminals).toEqual([]);
    };
    let operation: ReplyOperation | undefined;
    let sessionKey: string | undefined;
    let steerSource: RpcSourceRef | undefined;
    let deadline: (() => void) | undefined;
    let backingRun: Promise<void> | undefined;
    const provider = holdAssistantResponse("Original work completed.");
    const nativeSession =
      injection === "withdrawn" ? (await createTestSession()).session : undefined;
    const originalSetTimeout = globalThis.setTimeout;
    const timerSpy =
      injection === "withdrawn"
        ? vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
            if (delay === 120_000) {
              deadline = () => callback(...args);
            }
            return originalSetTimeout(callback, delay, ...args);
          })
        : undefined;
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const logGateway = { ...createSubsystemLogger("test/gateway"), info: vi.fn() };
    const { client, clients, getClientConnIds } = createRequestClients();
    const context = {
      getClientConnIds,
      logGateway,
      getSessionEventSubscriberConnIds: () => new Set(["custody-observer"]),
      broadcastToConnIds: vi.fn((event: string, payload: unknown) => {
        if (
          event === "sessions.changed" &&
          isRecord(payload) &&
          payload.sessionKey === sessionKey &&
          payload.reason === "agent.input.settled" &&
          isRpcSourceQueued(rpcSourceTesting.get(steerRunId))
        ) {
          dispatchSettled.resolve();
        }
      }),
      broadcast: vi.fn((event: string, payload: unknown) => {
        if (
          event === "chat" &&
          isRecord(payload) &&
          payload.runId === steerRunId &&
          (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
        ) {
          earlyTerminals.push(consumed.length === 0);
          steerTerminal.resolve();
        }
      }),
    };
    const request = { context, client };
    // Read through the public handler with the same live custody and physical session.
    const readInputCustody = async () => {
      const response = await directSessionReq<{
        pendingInputs: ChatPendingInputsPage;
        inputReceipts: ChatInputReceipts;
      }>("chat.history", { agentId: "main", sessionKey, inputRunIds: [steerRunId] }, request);
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      const history = expectDefined(response.payload, "input history");
      return {
        input: expectDefined(
          history.pendingInputs.items.find((input) => input.runId === steerRunId),
          "pending steering input",
        ),
        receipt: expectDefined(
          history.inputReceipts.find((receipt) => receipt.runId === steerRunId),
          "steering receipt",
        ),
        queuedCount: history.pendingInputs.queuedCount,
      };
    };
    const pendingCustody = async (queued = false, soft = false) => {
      const custody = await readInputCustody();
      const check = soft ? expect.soft : expect;
      if (!queued) {
        check(custody.input).not.toHaveProperty("queued");
      }
      check(custody.receipt).toEqual({
        runId: steerRunId,
        state: "pending",
        ...(queued ? { queued: true } : {}),
      });
      check(custody.queuedCount).toBe(queued ? 1 : 0);
      return custody;
    };
    const createWorktree = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
    const worktreeSpy = vi
      .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
      .mockImplementation(async function (this: ManagedWorktreeService, params) {
        preparing.resolve();
        await releaseWorkspace.promise;
        return createWorktree(this, params);
      });
    runtime.execute.mockImplementation(async ({ followupRun, opts, replyOperation }) => {
      const runId = expectDefined(opts?.runId, "runtime run ID");
      if (!operation) {
        operation = expectDefined(replyOperation, "initial reply admission");
        if (nativeSession) {
          streamMocks.streamSimple.mockImplementation(() => provider.response);
          backingRun = nativeSession.prompt("Continue the original backing work.");
          await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
        }
        runtimeStarted.resolve();
        await attachBackend.promise;
        operation.attachBackend({
          kind: "embedded",
          runId,
          supportsTranscriptCommitWait: true,
          terminalReplyExpectation: followupRun.run.terminalReplyExpectation,
          toolAuthorityFingerprint: operation.bindToolAuthorityRoute(followupRun.run),
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
              if (nativeSession) {
                return steerActiveSessionWithOptionalDeliveryWait(
                  nativeSession,
                  text,
                  {
                    ...options,
                    onQueueAccepted: (accepted) => {
                      options?.onQueueAccepted?.(accepted);
                      if (accepted) {
                        steerAccepted.resolve();
                      }
                    },
                  },
                  sessionKey,
                  () => {
                    assertCurrent();
                    return true;
                  },
                );
              }
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
        await releaseRun.promise;
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
      return successfulChatTurn(runId, "Included the regression proof.");
    });
    // Observe custody without replacing dispatch, reply preparation, or queue policy.
    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as Parameters<typeof dispatchInboundMessage>[0];
      if (params.replyOptions?.runId === steerRunId) {
        const lifecycle = expectDefined(params.replyOptions.turnAdoptionLifecycle, "input custody");
        const onDeferred = expectDefined(lifecycle.onDeferred, "queued input admission");
        lifecycle.onDeferred = (...args) => {
          const admitted = onDeferred(...args);
          inputQueued.resolve();
          return admitted;
        };
        const onSettled = lifecycle.onSettled;
        lifecycle.onSettled = async () => {
          await onSettled?.();
          queuedSettled.resolve();
        };
      }
      try {
        return await realDispatch(params);
      } finally {
        if (params.replyOptions?.runId === steerRunId) {
          steeringDispatchFinished.resolve();
        }
      }
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
        request,
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const createdSession = expectDefined(created.payload, "created session response");
      sessionKey = createdSession.key;
      await withinTest(preparing.promise, signal);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.pendingWorktree,
      ).toBeDefined();
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      const sent = await directSessionReq<{ runId: string; status: string }>(
        "chat.send",
        {
          agentId: "main",
          sessionKey,
          message: steerText,
          queueMode: "steer",
          idempotencyKey: steerRunId,
        },
        request,
      );
      expect(sent).toMatchObject({ ok: true, payload: { runId: steerRunId, status: "started" } });
      const steerEntry = expectDefined(
        rpcSourceTesting.get(steerRunId),
        "steer source registration",
      );
      steerSource = steerEntry;
      expect(earlyTerminals).toEqual([]);
      // The source is reserved, but workspace preparation has not deferred it to the queue.
      expect(steerEntry.input.custody.enqueued).not.toBe(true);
      const staged = await pendingCustody();
      expect(staged.input).toMatchObject({ state: "queued", runId: steerRunId });
      clock = 15_800;
      releaseWorkspace.resolve();
      await withinTest(inputQueued.promise, signal);
      // Steering can park before reply preparation reaches the runtime.
      await withinTest(runtimeStarted.promise, signal);
      expect(isRpcSourceQueued(rpcSourceTesting.get(steerRunId))).toBe(true);
      expect(operation?.phase).toBe("running");
      expectUnconsumed();
      await pendingCustody(false, true);
      attachBackend.resolve();
      await withinTest(
        (injection === "accepted" || nativeSession ? steerAccepted : steerDeclined).promise,
        signal,
      );
      expectUnconsumed();
      expect(rpcSourceTesting.get(steerRunId)).toBe(steerEntry);
      expect(isRpcSourceQueued(steerEntry)).toBe(true);
      if (injection === "accepted") {
        // Accepted steering retains cancellation custody but is not a follow-up queue item.
        await pendingCustody(false, true);
        releaseSteerCommit.resolve();
        await withinTest(steerTerminal.promise, signal);
        expect(consumed).toEqual([
          { runId: createdSession.runId, text: expect.stringContaining(steerText) },
        ]);
        expect(earlyTerminals).toEqual([false]);
        expect(runtime.execute).toHaveBeenCalledOnce();
      } else {
        if (nativeSession) {
          expect(nativeSession.getSteeringMessages()).toHaveLength(1);
          const settlement = expectDefined(
            steerEntry.input.injection,
            "native steer custody",
          ).settled;
          clock += 120_000;
          expectDefined(deadline, "embedded transcript delivery deadline")();
          expect(await withinTest(settlement, signal)).toBe(false);
          expect(nativeSession.getSteeringMessages()).toEqual([]);
          expect(isRpcSourceQueued(rpcSourceTesting.get(steerRunId))).toBe(true);
          await withinTest(steeringDispatchFinished.promise, signal);
        }
        // The real dispatch finalizer publishes this change before the parent can reply.
        await withinTest(dispatchSettled.promise, signal);
        const fallback = await pendingCustody(true);
        expect(fallback.input).toMatchObject({ runId: steerRunId, state: "queued", queued: true });
        expect(runtime.execute).toHaveBeenCalledOnce();
        expectUnconsumed();
        // Let the queued input finish its debounce before releasing the active run.
        clock += 500;
        provider.release();
        await backingRun;
        expectDefined(operation, "initial run owner").complete();
        releaseRun.resolve();
        await withinTest(followupStarted.promise, signal);
        expect(runtime.execute).toHaveBeenCalledTimes(2);
        expect(consumed).toEqual([{ runId: steerRunId, text: expect.stringContaining(steerText) }]);
        expect(consumed[0]?.runId).not.toBe(createdSession.runId);
        expect(earlyTerminals).toEqual([]);
        releaseFollowup.resolve();
        await withinTest(queuedSettled.promise, signal);
        expect(earlyTerminals).toEqual([false]);
        expect(context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId: steerRunId, state: "final" }),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );
      }
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      // Independent requests can finish in either order; each keeps its own disposition.
      expect(
        logGateway.info.mock.calls
          .filter(([message]) => message.startsWith("slow chat send"))
          .map(([message]) => message.match(/stage=(\w+)/)?.[1])
          .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(injection === "accepted" ? ["steer"] : ["queued", "startup"]);
      if (nativeSession) {
        const { sessionId } = expectDefined(
          loadSessionEntry({ agentId: "main", sessionKey, storePath }),
          "withdrawn input session",
        );
        expect(logGateway.info).toHaveBeenCalledWith(
          expect.stringContaining(`stage=queued sessionId=${sessionId} runId=${steerRunId}`),
        );
      }
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expectSingleUserInput(storePath, sessionKey, steerText);
    } finally {
      if (steerSource) {
        requestRpcSourceCancellation(steerSource, "test cleanup");
      }
      const released = captureSessionControllerSettlement({
        scope: storePath,
        identities: [sessionKey],
      });
      releaseWorkspace.resolve();
      attachBackend.resolve();
      releaseSteerCommit.resolve();
      releaseFollowup.resolve();
      timerSpy?.mockRestore();
      provider.release();
      await backingRun;
      clearFixture(storePath, sessionKey);
      operation?.complete();
      releaseRun.resolve();
      await released;
      worktreeSpy.mockRestore();
      resetFixture(clients);
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
    assertNoRetainedSessionSharingReads();
  },
);

test("queues a fresh follow-up while stopped preparation still owns the reply slot", async ({
  signal,
}) => {
  const realDispatch = await loadRealChatDispatch();
  testState.agentConfig = { workspace: tempDirs.make("openclaw-stopped-preparation-") };
  const { storePath } = await createSessionStoreDir();
  const preparationStarted = createDeferred();
  const initialAborted = createDeferred();
  const releasePreparation = createDeferred();
  const followupDispatched = createDeferred();
  const followupStarted = createDeferred();
  const followupFinished = createDeferred();
  const followupRunId = "after-stopped-preparation";
  const followupText = "Continue with the new request.";
  let operation: ReplyOperation | undefined;
  let stopping: ReturnType<typeof directSessionReq> | undefined;
  let sessionKey: string | undefined;
  const consumed: string[] = [];
  const { client, clients, getClientConnIds } = createRequestClients();
  const context = {
    getClientConnIds,
    broadcast: vi.fn((event: string, payload: unknown) => {
      if (
        event === "chat" &&
        isRecord(payload) &&
        payload.runId === followupRunId &&
        payload.state === "final"
      ) {
        followupFinished.resolve();
      }
    }),
  };
  const request = { client, context };
  runtime.execute.mockImplementation(async ({ followupRun, opts, replyOperation }) => {
    const runId = expectDefined(opts?.runId, "runtime run ID");
    if (!operation) {
      operation = expectDefined(replyOperation, "initial reply owner");
      operation.abortSignal.addEventListener("abort", () => initialAborted.resolve(), {
        once: true,
      });
      preparationStarted.resolve();
      // Model execution has not begun; asynchronous workspace setup still owns the attempt.
      await releasePreparation.promise;
      operation.abortSignal.throwIfAborted();
    } else {
      opts?.onAgentRunStart?.(runId);
      await expectDefined(
        followupRun.userTurnTranscriptRecorder,
        "follow-up input",
      ).persistApproved();
      consumed.push(followupRun.prompt);
      followupStarted.resolve();
    }
    return successfulChatTurn(runId, "The new request completed.");
  });
  dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
    const params = raw as Parameters<typeof dispatchInboundMessage>[0];
    try {
      return await realDispatch(params);
    } finally {
      if (params.replyOptions?.runId === followupRunId) {
        followupDispatched.resolve();
      }
    }
  });
  try {
    const created = await directSessionReq<{ key: string; runId: string }>(
      "sessions.create",
      { agentId: "main", message: "Prepare the initial request." },
      request,
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const session = expectDefined(created.payload, "created session");
    sessionKey = session.key;
    await withinTest(preparationStarted.promise, signal);
    stopping = directSessionReq("chat.abort", { sessionKey, runId: session.runId }, request);
    await withinTest(initialAborted.promise, signal);
    expect(operation?.abortSignal.aborted).toBe(true);
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    const sent = await directSessionReq(
      "chat.send",
      { sessionKey, message: followupText, idempotencyKey: followupRunId },
      request,
    );
    expect(sent).toMatchObject({ ok: true, payload: { runId: followupRunId, status: "started" } });
    await withinTest(followupDispatched.promise, signal);
    expect(consumed).toEqual([]);
    expect(isRpcSourceQueued(rpcSourceTesting.get(followupRunId))).toBe(true);
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    releasePreparation.resolve();
    const stopped = await withinTest(stopping, signal);
    expect(stopped.ok, JSON.stringify(stopped.error)).toBe(true);
    await withinTest(followupStarted.promise, signal);
    await withinTest(followupFinished.promise, signal);
    expect(consumed).toEqual([expect.stringContaining(followupText)]);
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(operation?.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
    expectSingleUserInput(storePath, sessionKey, followupText);
  } finally {
    const released = captureSessionControllerSettlement({
      scope: storePath,
      identities: [sessionKey],
    });
    releasePreparation.resolve();
    clearFixture(storePath, sessionKey);
    await Promise.all([released, stopping]);
    resetFixture(clients);
    testState.agentConfig = undefined;
  }
});
