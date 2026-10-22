import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import {
  settleDurableDelivery,
  settlePendingFinalDelivery,
} from "../../infra/outbound/delivery-completion.js";
import { createPendingFinalFixture } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import type { ChannelTurnDeliveryAdapter } from "./types.js";

const dispatchCore = vi.hoisted(() => vi.fn());
const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const withDurableDeliveryRuntime = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/dispatch.js")>()),
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatchCore,
}));
vi.mock("../session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.js")>()),
  recordInboundSession: vi.fn(async () => undefined),
}));
vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("./durable-delivery-runtime.js", () => ({ withDurableDeliveryRuntime }));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.js")>()),
  appendAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

describe("pending delivery notice end to end", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-notice-e2e-");
  let storePath: string;
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const route = { channel: "telegram", accountId: "default" };
  const context = { ...route, to: "chat-1" };
  let completion: ReturnType<typeof createPendingFinalFixture>["completion"];
  const locator = () => ({ sessionKey, storePath });
  const entry = () => loadSessionEntry(locator());
  const settlementRef = () => completion;
  const settle = (state: "queued" | "unknown") =>
    settlePendingFinalDelivery(settlementRef(), state, ["prepared"]);
  const visible = async () => ({ visibleReplySent: true });
  const finalPayload = (bindCustody = true, custody = completion) => {
    const payload = { text: "the final answer" };
    return bindCustody
      ? setReplyPayloadMetadata(payload, { pendingFinalDeliveryCompletion: custody })
      : payload;
  };
  const dispatch = (delivery: ChannelTurnDeliveryAdapter) =>
    dispatchRoutedChannelTurn({
      cfg: { session: { store: storePath } },
      ...route,
      route: { agentId: "main", sessionKey },
      ctxPayload: {
        CommandAuthorized: false,
        To: "chat-1",
        SessionKey: sessionKey,
        Surface: "telegram",
      },
      delivery,
    });
  const expectNoticeState = (suppressed: boolean) =>
    expect(entry()?.pendingDeliveryNotice?.state).toBe(suppressed ? "unresolved" : "acknowledged");

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue({ suppressed: false });
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    storePath = path.join(sessionDirs.make(), "sessions.json");
    const fixture = createPendingFinalFixture(storePath, "delivery-e2e", sessionKey, {
      text: "the final answer",
      context,
      now: Date.now(),
    });
    completion = fixture.completion;
    await replaceSessionEntry(locator(), {
      ...fixture.entry,
      status: "done",
      delivery: { kind: "external", route, context, origin: {} },
    });
  });

  const runTurn = (deliver: typeof visible, bindCustody = true) => {
    dispatchCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver(finalPayload(bindCustody), { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    return dispatch({ deliver });
  };
  const freshTurn = () => runTurn(visible, false);
  function queueFinal(prepared = false, custody = completion, beforeIdle = Promise.resolve()) {
    dispatchCore.mockImplementationOnce(async (params) => {
      const dispatcher = createReplyDispatcher(params.dispatcherOptions);
      const payload = finalPayload(true, custody);
      if (prepared) {
        const [plan] = createStructuredOutboundPayloadPlan([payload]);
        if (!plan) {
          throw new Error("expected prepared final");
        }
        dispatcher.sendPreparedReply("final", plan);
      } else {
        dispatcher.sendFinalReply(payload);
      }
      dispatcher.markComplete();
      await beforeIdle;
      const settledReceipt = await dispatcher.waitForIdle();
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
    });
  }

  it.each(["prepared", "queued"] as const)("silent during %s send", async (state) => {
    if (state === "queued") {
      await settle("queued");
    }
    const sending = createDeferred();
    const finish = createDeferred();
    const attempt = runTurn(async () => {
      sending.resolve();
      const finalization = finish.promise.then(visible);
      return state === "queued" ? { visibleReplySent: false, finalization } : await finalization;
    });
    await sending.promise;
    try {
      await freshTurn();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      expect(entry()?.pendingDeliveryNotice?.state).toBe("owed");

      // A refused duplicate admission cannot release the original send's custody.
      const duplicate = vi.fn(visible);
      await runTurn(duplicate);
      expect(duplicate).not.toHaveBeenCalled();
      await freshTurn();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await attempt;
    }
    await freshTurn();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(entry()?.pendingDeliveryNotice).toBeUndefined();
  });

  it("preserves ambiguous sends after deferred admission refusal", async () => {
    await settle("unknown");
    const admittedEntry = await readSessionEntryReadOnlyInWorker(locator());
    const platformSend = vi.fn();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const buffered = createDeferred();
      const flush = createDeferred();
      queueFinal(false, { ...completion }, buffered.promise.then(flush.resolve));
      await expect(
        dispatch({
          deliverWithProviderMessageSending: async (_payload, info) => {
            buffered.resolve();
            return {
              visibleReplySent: false,
              finalization: flush.promise.then(async () => {
                await info.onPlatformSendDispatch();
                platformSend();
                return visible();
              }),
            };
          },
        }),
      ).resolves.toMatchObject({ dispatched: true });
      const afterReplay = await readSessionEntryReadOnlyInWorker(locator());
      expect(afterReplay?.pendingFinalDelivery).toEqual(admittedEntry?.pendingFinalDelivery);
      expect(afterReplay?.pendingDeliveryNotice).toEqual({
        ...admittedEntry?.pendingDeliveryNotice,
        state: "acknowledged",
      });
    }
    expect(platformSend).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
  });

  it.each([
    { failure: "rejected", operation: "raw", state: "suppressed" },
    { failure: "rejected", operation: "prepared", state: "suppressed" },
    { failure: "retryable", operation: "raw", state: "prepared" },
    { failure: "retryable", operation: "prepared", state: "prepared" },
    { failure: "queue-owned", operation: "raw", state: "queued" },
    { failure: "queue-owned", operation: "prepared", state: "queued" },
  ] as const)("no notice: $failure/$operation", async ({ failure, operation, state }) => {
    const cause = new PlatformMessageNotDispatchedError("sender preflight failed", {
      cause: undefined,
      retryable: failure !== "rejected",
    });
    const error =
      failure === "queue-owned"
        ? Object.assign(new OutboundDeliveryError(cause.message, { cause }), {
            queueCustody: "held",
          })
        : cause;
    withDurableDeliveryRuntime.mockImplementationOnce(async () => {
      if (failure === "queue-owned") {
        await settle("queued");
      }
      throw error;
    });
    queueFinal(operation === "prepared");
    const deliver = vi.fn(visible);
    const onError = vi.fn();
    await dispatch({ deliver, durable: {}, onError });

    const current = entry();
    expect(current?.pendingFinalDelivery?.deliveries).toEqual([
      { id: completion.deliveryId, state },
    ]);
    expect(current?.pendingDeliveryNotice).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, { kind: "final" });

    await freshTurn();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles suppression=%s once", async (suppressed) => {
    sendRecoveryNotice.mockResolvedValue({ suppressed });
    const ambiguous = new Error("socket closed before response");
    await expect(runTurn(() => Promise.reject(ambiguous))).rejects.toBe(ambiguous);

    expect(entry()).toMatchObject({
      pendingFinalDelivery: { deliveries: [{ id: completion.deliveryId, state: "unknown" }] },
      pendingDeliveryNotice: { intentId: completion.intentId, state: "owed" },
    });
    expect(sendRecoveryNotice).not.toHaveBeenCalled();

    await freshTurn();
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...context,
        text: expect.stringContaining("couldn’t confirm"),
      }),
    );
    expectNoticeState(suppressed);
    if (suppressed) {
      expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    }

    await closeOpenClawAgentDatabasesAsync(path.dirname(storePath));
    closeOpenClawAgentDatabasesForTest(path.dirname(storePath));
    // A queue restart can repeat owner settlement after its first write committed.
    await settleDurableDelivery(settlementRef(), { platformSendStarted: true });
    await freshTurn();
    expect(sendRecoveryNotice).toHaveBeenCalledTimes(1);
    expectNoticeState(suppressed);
  });
});
