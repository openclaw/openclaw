import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

const { dispatchInboundMessageMock, emitMessageSentHooksMock, setDispatchPayload } = vi.hoisted(
  () => {
    let dispatchPayload: ReplyPayload = { text: "model reply" };
    return {
      setDispatchPayload: (payload: ReplyPayload) => {
        dispatchPayload = payload;
      },
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          dispatcher: {
            sendFinalReply: (payload: ReplyPayload) => boolean;
            waitForIdle: () => Promise<void>;
          };
        }) => {
          params.dispatcher.sendFinalReply(dispatchPayload);
          await params.dispatcher.waitForIdle();
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        },
      ),
      emitMessageSentHooksMock: vi.fn(),
    };
  },
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

vi.mock("../../hooks/message-sent.js", () => ({
  emitMessageSentHooks: emitMessageSentHooksMock,
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

function createDeliveryHookHandler(params: {
  deliverReplies: SignalEventHandlerDeps["deliverReplies"];
}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: { messages: { inbound: { debounceMs: 0 } } },
      historyLimit: 0,
      deliverReplies: params.deliverReplies,
    }),
  );
}

describe("signal message:sent delivery hooks", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockClear();
    emitMessageSentHooksMock.mockClear();
    setDispatchPayload({ text: "model reply" });
  });

  it("does not emit success hooks when delivery reports delivered=false", async () => {
    const deliverReplies = vi.fn<SignalEventHandlerDeps["deliverReplies"]>(async () => ({
      delivered: false,
    }));
    const handler = createDeliveryHookHandler({ deliverReplies });

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHooksMock).not.toHaveBeenCalled();
  });

  it("emits success hooks with messageId when delivery reports delivered=true", async () => {
    const deliverReplies = vi.fn<SignalEventHandlerDeps["deliverReplies"]>(async () => ({
      delivered: true,
      messageId: "signal-msg-1",
    }));
    const handler = createDeliveryHookHandler({ deliverReplies });

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHooksMock.mock.calls[0]?.[0]).toMatchObject({
      to: "+15550001111",
      content: "model reply",
      success: true,
      channelId: "signal",
      accountId: "default",
      messageId: "signal-msg-1",
    });
  });

  it("emits success hooks with deliveredContent when provided", async () => {
    setDispatchPayload({ text: "|A|B|   " });
    const deliverReplies = vi.fn<SignalEventHandlerDeps["deliverReplies"]>(async () => ({
      delivered: true,
      messageId: "signal-msg-2",
      deliveredContent: "A\tB",
    }));
    const handler = createDeliveryHookHandler({ deliverReplies });

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHooksMock.mock.calls[0]?.[0]).toMatchObject({
      to: "+15550001111",
      content: "A\tB",
      success: true,
      channelId: "signal",
      accountId: "default",
      messageId: "signal-msg-2",
    });
  });
});
