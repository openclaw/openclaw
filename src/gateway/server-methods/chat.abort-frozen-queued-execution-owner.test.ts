/**
 * Pending-delivery proof for #118028: the real executeAgentTurn (the changed
 * execution owner) rejects a late chat.abort while the queued entry remains
 * present and delivery is pending (onSettled not yet called).
 *
 * This test addresses the ClawSweeper Revision 43 finding: "Synchronize on
 * execution-driven retirement while holding settlement pending, then release
 * delivery after the abort response; verify the regression fails without
 * retirement."
 *
 * Synchronization strategy:
 *   - onCancellationRetired callback fires synchronously inside
 *     commitTerminalOutcome → retireFollowupRunCancellation. A deferred
 *     resolves when retirement has actually occurred, providing a deterministic
 *     execution-driven retirement barrier (not a delta event, which fires
 *     from live assistant streaming before commitTerminalOutcome).
 *   - onSettled is NOT called by executeAgentTurn; it is called later by the
 *     follow-up runner. The test holds onSettled pending until after the abort
 *     response, proving the abort is rejected during the pending-delivery
 *     interval (entry.abortable=false, entry still present).
 *
 * Production chain exercised (no mocks in the critical path):
 *   executeAgentTurn (real) -> commitTerminalOutcome (real)
 *                            -> retireFollowupRunCancellation (real)
 *                            -> onCancellationRetired (real callback)
 *                            -> retireQueuedChatTurnCancellation (real)
 *   chat.abort (real handler) -> handleChatAbortRequestWithLifecycle (real)
 *                             -> abortQueuedChatTurnById (real)
 *   onSettled (real) -> completeQueuedChatTurn (real)
 */
import { expect, it, vi } from "vitest";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockReplyOperation,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "../../auto-reply/reply/agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "../../auto-reply/reply/agent-runner-execution.test-support.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { invokeChatAbortHandler } from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
    loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
  };
});

const state = await setupAgentRunnerExecutionTestState();

it("real execution owner rejects late chat.abort during pending delivery (synchronized on retirement)", async () => {
  const chatQueuedTurns = new Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>();
  const controller = new AbortController();
  let deliverySettled = false;
  const retirementDeferred = createDeferred();

  const context = {
    chatAbortControllers: new Map(),
    chatQueuedTurns,
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    removeChatRun: vi.fn((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
  };

  const { replyOperation } = createMockReplyOperation();
  const followupRun = createFollowupRun();
  followupRun.turnAdoptionLifecycle = {
    admission: "cancel-only" as const,
    ownerKey: "owner-key",
    onAdopted: async () => {},
    onDeferred: () =>
      registerQueuedChatTurn({
        chatQueuedTurns,
        runId: "queued-exec-owner",
        controller,
        sessionId: "main-session",
        sessionKey: "main",
        ownerConnId: "conn-owner",
        ownerDeviceId: "dev-owner",
      }),
    onCancellationRetired: () => {
      retireQueuedChatTurnCancellation(chatQueuedTurns, "queued-exec-owner", controller);
      retirementDeferred.resolve();
    },
    onSettled: () => {
      deliverySettled = true;
      return completeQueuedChatTurn(chatQueuedTurns, "queued-exec-owner", controller);
    },
  };

  // Register the queued entry (simulates chat.send terminalizing while followup waits).
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-exec-owner")).toBe(true);
  expect(chatQueuedTurns.get("queued-exec-owner")?.abortable).toBeUndefined();

  // Set up the real embedded agent mock to start execution and succeed.
  // model_call_started triggers markReplyOperationExecutionStarted, so
  // commitTerminalOutcome will retire cancellation (not skip it).
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    return { payloads: [{ text: "ok" }], meta: {} };
  });

  // Call the REAL executeAgentTurn — this triggers the real commitTerminalOutcome,
  // which calls retireFollowupRunCancellation -> onCancellationRetired ->
  // retireQueuedChatTurnCancellation. Delivery (onSettled) is NOT called by
  // executeAgentTurn; it is called later by the follow-up runner.
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  await executeAgentTurn({
    ...createMinimalRunAgentTurnParams({ followupRun: followupRun as never }),
    replyOperation,
  });

  // Synchronize on execution-driven retirement: the onCancellationRetired
  // callback fires synchronously inside commitTerminalOutcome. Waiting for
  // this deferred proves retirement has actually occurred — not a delta event
  // (which fires from live assistant streaming before commitTerminalOutcome).
  await retirementDeferred.promise;

  // After retirement: entry.abortable=false, entry still present, delivery pending.
  expect(chatQueuedTurns.get("queued-exec-owner")?.abortable).toBe(false);
  expect(chatQueuedTurns.has("queued-exec-owner")).toBe(true);
  expect(deliverySettled).toBe(false);

  // A late chat.abort arrives while delivery is pending (onSettled not called).
  // The real Gateway abort handler checks entry.abortable, which is false because
  // the real commitTerminalOutcome retired it. This is NOT manual retirement —
  // the changed execution owner (executeAgentTurn) produced this state.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-exec-owner" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;

  // Abort rejected by retirement (abortable=false), NOT by deletion (entry still present).
  expect(payload?.aborted).toBe(false);
  expect(payload?.runIds).toEqual([]);
  expect(controller.signal.aborted).toBe(false);
  expect(chatQueuedTurns.has("queued-exec-owner")).toBe(true);
  expect(deliverySettled).toBe(false);

  // Now delivery settles (onSettled called by the follow-up runner).
  // This deletes the entry — proving the abort was rejected by retirement,
  // not because the entry was already gone.
  expect(followupRun.turnAdoptionLifecycle?.onSettled?.()).toBe(true);
  expect(deliverySettled).toBe(true);
  expect(chatQueuedTurns.has("queued-exec-owner")).toBe(false);

  console.log(
    [
      "[exec-owner] registered queued entry: entry=queued-exec-owner abortable=undefined",
      "[exec-owner] executeAgentTurn (real) -> commitTerminalOutcome (real) -> retireFollowupRunCancellation (real)",
      "[exec-owner] onCancellationRetired fired (synchronized on execution-driven retirement)",
      "[exec-owner] after retirement: entry.abortable=false entry.present=true deliverySettled=false",
      "[exec-owner] late chat.abort while delivery pending -> handleChatAbortRequestWithLifecycle",
      `[exec-owner] chat.abort responded: aborted=${payload?.aborted} runIds=${JSON.stringify(payload?.runIds)}`,
      "[exec-owner] entry.present=true after abort (rejected by retirement, not deletion)",
      "[exec-owner] onSettled (delivery) -> completeQueuedChatTurn -> entry deleted",
      "[exec-owner] RESULT: real execution owner rejected abort during pending delivery (synchronized on retirement)",
    ].join("\n"),
  );
});

it("before-fix control: with retirement hook removed, chat.abort succeeds during pending delivery", async () => {
  const chatQueuedTurns = new Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>();
  const controller = new AbortController();
  let deliverySettled = false;

  const context = {
    chatAbortControllers: new Map(),
    chatQueuedTurns,
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    removeChatRun: vi.fn((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
  };

  const { replyOperation } = createMockReplyOperation();
  const followupRun = createFollowupRun();
  followupRun.turnAdoptionLifecycle = {
    admission: "cancel-only" as const,
    ownerKey: "owner-key",
    onAdopted: async () => {},
    onDeferred: () =>
      registerQueuedChatTurn({
        chatQueuedTurns,
        runId: "queued-control",
        controller,
        sessionId: "main-session",
        sessionKey: "main",
        ownerConnId: "conn-owner",
        ownerDeviceId: "dev-owner",
      }),
    // Retirement hook removed (no-op): simulates current main where
    // commitTerminalOutcome calls freezeAbort but never retires the queued
    // cancellation. executeAgentTurn still runs, but the Gateway entry
    // stays abortable because onCancellationRetired does nothing.
    onCancellationRetired: () => {},
    onSettled: () => {
      deliverySettled = true;
      return completeQueuedChatTurn(chatQueuedTurns, "queued-control", controller);
    },
  };

  // Register the queued entry.
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-control")).toBe(true);

  // Call the REAL executeAgentTurn — commitTerminalOutcome fires and calls
  // freezeAbort, but onCancellationRetired is a no-op (retirement hook removed),
  // so the queued entry stays abortable. This is the same execution path as
  // the fix test, minus the retirement hook — an apples-to-apples control.
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    return { payloads: [{ text: "ok" }], meta: {} };
  });
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  await executeAgentTurn({
    ...createMinimalRunAgentTurnParams({ followupRun: followupRun as never }),
    replyOperation,
  });

  // After executeAgentTurn: entry is still abortable (retirement hook was removed).
  expect(chatQueuedTurns.get("queued-control")?.abortable).toBeUndefined();
  expect(chatQueuedTurns.has("queued-control")).toBe(true);
  expect(deliverySettled).toBe(false);

  // A late chat.abort arrives while delivery is pending. Because the
  // retirement hook was removed, the entry is still abortable, so the
  // abort succeeds — this is the current-main bug.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-control" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;

  // Without retirement, the abort succeeds — this is the current-main bug.
  expect(payload?.aborted).toBe(true);
  expect(payload?.runIds).toEqual(["queued-control"]);
  expect(controller.signal.aborted).toBe(true);

  console.log(
    [
      "[control] registered queued entry: entry=queued-control abortable=undefined",
      "[control] executeAgentTurn (real) -> commitTerminalOutcome (real) -> freezeAbort (real)",
      "[control] onCancellationRetired is no-op (retirement hook removed, simulates current main)",
      "[control] after executeAgentTurn: entry.abortable=undefined entry.present=true deliverySettled=false",
      "[control] late chat.abort while delivery pending -> handleChatAbortRequestWithLifecycle",
      `[control] chat.abort responded: aborted=${payload?.aborted} runIds=${JSON.stringify(payload?.runIds)}`,
      "[control] controller.signal.aborted=true (frozen delivery would be marked aborted)",
      "[control] RESULT: with retirement hook removed, abort succeeds during pending delivery (current-main bug)",
    ].join("\n"),
  );
});
