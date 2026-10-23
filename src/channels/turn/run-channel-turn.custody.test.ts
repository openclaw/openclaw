import { beforeEach, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { PlatformMessageNotDispatchedError as SendRejected } from "../../infra/outbound/deliver-types.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createDirectPendingFinalCustody } from "./direct-delivery-custody.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import { createCtx } from "./run-channel-turn.delivery.test-helpers.js";
import type {
  ChannelProviderOwnedMessageSendingDeliveryAdapter as ProviderDelivery,
  ChannelTurnDeliveryAdapter,
} from "./types.js";

const dispatchCore = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/dispatch.js")>()),
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatchCore,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner,
}));

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>()),
  settlePendingFinalDelivery,
}));

function dispatchPayload(payload: ReplyPayload, prepared = false): DispatchReplyWithDispatcher {
  return async (params) => {
    if (prepared) {
      const [plan] = createStructuredOutboundPayloadPlan([payload]);
      if (!plan || !params.dispatcherOptions.deliverPrepared) {
        throw new Error("expected prepared delivery operation");
      }
      await params.dispatcherOptions.deliverPrepared(plan, { kind: "final" });
    } else {
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
    }
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  };
}

const completion = {
  deliveryId: "delivery-failed",
  intentId: "intent-failed",
  sessionId: "session-failed",
  sessionKey: "agent:main:telegram:peer",
  storePath: "/tmp/sessions.json",
};
const identity = { kind: "pending-final", ...completion };
const currentWriter = {
  activeWriterRunId: "run-old",
  lifecycleRevision: "revision-a",
  sessionId: completion.sessionId,
};
const replacementWriter = { ...currentWriter, activeWriterRunId: "run-new" };
let currentEntry: typeof currentWriter | undefined;

const authority = {
  agentId: "main",
  expectedLifecycleRevision: currentWriter.lifecycleRevision,
  expectedSessionId: completion.sessionId,
  expectedWriterRunId: currentWriter.activeWriterRunId,
  sessionKey: completion.sessionKey,
  storePath: completion.storePath,
  readCurrentSession: () => currentEntry,
};
function createPayload(writer = false, pendingFinal = false) {
  const metadata = {
    ...(pendingFinal ? { pendingFinalDeliveryCompletion: completion } : {}),
    ...(writer ? { sessionWriterDeliveryAuthority: authority } : {}),
  };
  return setReplyPayloadMetadata({ text: "reply" }, metadata);
}

function dispatch(delivery: ChannelTurnDeliveryAdapter) {
  return dispatchRoutedChannelTurn({
    cfg: {},
    channel: "telegram",
    accountId: "acct",
    route: { agentId: "main", sessionKey: completion.sessionKey },
    ctxPayload: createCtx({
      CommandAuthorized: false,
      Surface: "telegram",
      OriginatingTo: "chat-1",
    }),
    delivery,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getGlobalHookRunner.mockReturnValue(null);
  currentEntry = undefined;
});

it.each(["raw", "prepared"] as const)(
  "blocks %s I/O after writer replacement",
  async (operation) => {
    const changesAfterRefresh = operation === "prepared";
    dispatchCore.mockImplementationOnce(dispatchPayload(createPayload(true), changesAfterRefresh));
    currentEntry = changesAfterRefresh ? currentWriter : replacementWriter;
    const stages: string[] = [];
    const platformSend = vi.fn(async (_payload: ReplyPayload) => ({ visibleReplySent: true }));
    const send: ProviderDelivery["deliverWithProviderMessageSending"] = async (value, info) => {
      stages.push("entered");
      await info.onPlatformSendDispatch();
      stages.push("refreshed");
      // Notice reads precede provider entry; revoke only after custody refresh.
      currentEntry = replacementWriter;
      info.assertPlatformSendAuthorized();
      return platformSend(value);
    };
    const raw = vi.fn(send);
    const prepared = vi.fn<
      NonNullable<ProviderDelivery["deliverPreparedWithProviderMessageSending"]>
    >((plan, info) => send(plan.payload, info));
    await expect(
      dispatch({
        preparePayload: async (value) => ({ ...value }),
        deliverWithProviderMessageSending: raw,
        deliverPreparedWithProviderMessageSending: prepared,
      }),
    ).rejects.toBeInstanceOf(SendRejected);
    expect(stages).toEqual(changesAfterRefresh ? ["entered", "refreshed"] : ["entered"]);
    expect(platformSend).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledTimes(operation === "raw" ? 1 : 0);
    expect(prepared).toHaveBeenCalledTimes(operation === "prepared" ? 1 : 0);
  },
);

it("retains custody across posts but rejects a replaced writer", async () => {
  currentEntry = currentWriter;
  const custody = await createDirectPendingFinalCustody(createPayload(true, true));
  if (!custody) {
    throw new Error("expected pending-final custody");
  }
  await custody.onPlatformSendDispatch();
  await custody.onPlatformSendDispatch();
  expect(settlePendingFinalDelivery).toHaveBeenCalledOnce();
  currentEntry = replacementWriter;
  await expect(custody.onPlatformSendDispatch()).rejects.toBeInstanceOf(SendRejected);
  custody.release();
});

it.each([
  [
    "suppressed",
    new SendRejected("rejected", { cause: undefined, retryable: false }),
    ["prepared", "queued", "unknown"],
  ],
  ["unknown", new Error("adapter failed after entry"), ["queued", "unknown"]],
  ["prepared", new SendRejected("preflight", { cause: undefined }), ["queued", "unknown"]],
] as const)("settles failed-send custody as %s", async (state, error, expected) => {
  dispatchCore.mockImplementationOnce(dispatchPayload(createPayload(false, true)));
  await expect(
    dispatch({
      deliver: async () => {
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(settlePendingFinalDelivery.mock.calls).toEqual([
    [identity, "unknown", ["prepared", "queued"]],
    [identity, state, expected],
  ]);
});
