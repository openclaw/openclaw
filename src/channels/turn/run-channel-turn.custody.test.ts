import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createDirectPendingFinalCustody } from "./direct-delivery-custody.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import { createCtx } from "./run-channel-turn.delivery.test-helpers.js";
import type { ChannelProviderOwnedMessageSendingDeliveryAdapter } from "./types.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const loadSessionEntryReadOnly = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, loadSessionEntryReadOnly };
});

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery };
});

function createPayloadDispatch(
  payload: ReplyPayload,
  operation: "raw" | "prepared",
): DispatchReplyWithDispatcher {
  return async (params) => {
    if (operation === "prepared") {
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

describe("channel turn failed-send custody", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    getGlobalHookRunner.mockReturnValue(null);
    loadSessionEntryReadOnly.mockReturnValue(undefined);
    settlePendingFinalDelivery.mockImplementation(async (_completion, state: string) => ({
      state,
    }));
  });

  it.each([
    { operation: "raw", changesAfterRefresh: false },
    { operation: "prepared", changesAfterRefresh: true },
  ] as const)(
    "blocks $operation provider I/O when writer authority changes (after refresh: $changesAfterRefresh)",
    async ({ operation, changesAfterRefresh }) => {
      const payload = setReplyPayloadMetadata(
        { text: "old writer reply" },
        {
          sessionWriterDeliveryAuthority: {
            agentId: "main",
            expectedLifecycleRevision: currentWriter.lifecycleRevision,
            expectedSessionId: completion.sessionId,
            expectedWriterRunId: currentWriter.activeWriterRunId,
            sessionKey: completion.sessionKey,
            storePath: completion.storePath,
          },
        },
      );
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
        createPayloadDispatch(payload, operation),
      );
      loadSessionEntryReadOnly.mockReturnValue(
        changesAfterRefresh ? currentWriter : replacementWriter,
      );
      const stages: string[] = [];
      const platformSend = vi.fn(async (_payload: ReplyPayload) => ({ visibleReplySent: true }));
      const providerSend: ChannelProviderOwnedMessageSendingDeliveryAdapter["deliverWithProviderMessageSending"] =
        async (value, info) => {
          stages.push("entered");
          await info.onPlatformSendDispatch();
          stages.push("refreshed");
          // Notice reads precede provider entry; revoke only after custody refresh.
          loadSessionEntryReadOnly.mockReturnValue(replacementWriter);
          info.assertPlatformSendAuthorized();
          return platformSend(value);
        };
      const raw = vi.fn(providerSend);
      const prepared = vi.fn<
        NonNullable<
          ChannelProviderOwnedMessageSendingDeliveryAdapter["deliverPreparedWithProviderMessageSending"]
        >
      >((plan, info) => providerSend(plan.payload, info));
      await expect(
        dispatchRoutedChannelTurn({
          cfg: {},
          channel: "telegram",
          accountId: "acct",
          route: { agentId: "main", sessionKey: completion.sessionKey },
          ctxPayload: createCtx({
            CommandAuthorized: false,
            Surface: "telegram",
            OriginatingTo: "chat-1",
          }),
          delivery: {
            preparePayload: async (value) => ({ ...value }),
            deliverWithProviderMessageSending: raw,
            deliverPreparedWithProviderMessageSending: prepared,
          },
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(stages).toEqual(changesAfterRefresh ? ["entered", "refreshed"] : ["entered"]);
      expect(loadSessionEntryReadOnly).toHaveBeenCalledWith({
        agentId: "main",
        readConsistency: "latest",
        sessionKey: completion.sessionKey,
        storePath: completion.storePath,
      });
      expect(platformSend).not.toHaveBeenCalled();
      expect(raw).toHaveBeenCalledTimes(operation === "raw" ? 1 : 0);
      expect(prepared).toHaveBeenCalledTimes(operation === "prepared" ? 1 : 0);
    },
  );

  it("serializes and revalidates custody before every provider post", async () => {
    const custody = createDirectPendingFinalCustody(
      setReplyPayloadMetadata({ text: "reply" }, { pendingFinalDeliveryCompletion: completion }),
    );
    if (!custody) {
      throw new Error("expected pending-final custody");
    }
    const firstCheck = createDeferred<{ state: "unknown" }>();
    settlePendingFinalDelivery
      .mockImplementationOnce(async () => firstCheck.promise)
      .mockResolvedValueOnce({ state: "suppressed" });
    const first = custody.onPlatformSendDispatch();
    const second = custody.onPlatformSendDispatch();
    await Promise.resolve();
    expect(settlePendingFinalDelivery).toHaveBeenCalledOnce();
    firstCheck.resolve({ state: "unknown" });
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(1, identity, "unknown", [
      "prepared",
      "queued",
    ]);
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(2, identity, "unknown", ["unknown"]);
  });

  it.each([
    {
      label: "permanent rejection suppresses",
      error: new PlatformMessageNotDispatchedError("rejected", {
        cause: undefined,
        retryable: false,
      }),
      state: "suppressed",
      expected: ["prepared", "queued", "unknown"],
    },
    {
      label: "untyped failure remains unknown",
      error: new Error("adapter failed after entry"),
      state: "unknown",
      expected: ["queued", "unknown"],
    },
    {
      label: "retryable rejection restores prepared custody",
      error: new PlatformMessageNotDispatchedError("preflight failed", {
        cause: new Error("local preflight"),
      }),
      state: "prepared",
      expected: ["queued", "unknown"],
    },
  ])("$label", async ({ error, state, expected }) => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
      createPayloadDispatch(
        setReplyPayloadMetadata({ text: "reply" }, { pendingFinalDeliveryCompletion: completion }),
        "raw",
      ),
    );
    await expect(
      dispatchRoutedChannelTurn({
        cfg: {},
        channel: "telegram",
        accountId: "acct",
        route: { agentId: "main", sessionKey: completion.sessionKey },
        ctxPayload: createCtx({
          CommandAuthorized: false,
          Surface: "telegram",
          OriginatingTo: "chat-1",
        }),
        delivery: {
          deliver: async () => {
            throw error;
          },
        },
      }),
    ).rejects.toBe(error);
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(1, identity, "unknown", [
      "prepared",
      "queued",
    ]);
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(2, identity, state, expected);
  });
});
