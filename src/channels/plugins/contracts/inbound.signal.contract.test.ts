import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "../../../../extensions/signal/src/monitor/event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "../../../../extensions/signal/src/monitor/event-handler.test-harness.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { expectChannelInboundContextContract } from "./suites.js";

const capture = vi.hoisted(() => ({ ctx: undefined as MsgContext | undefined }));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      ctx: MsgContext;
      replyOptions?: { onReplyStart?: () => void | Promise<void> };
    }) => {
      capture.ctx = params.ctx;
      await Promise.resolve(params.replyOptions?.onReplyStart?.());
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  ),
);

vi.mock("../../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../../extensions/signal/src/send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal inbound contract", () => {
  beforeEach(() => {
    capture.ctx = undefined;
    dispatchInboundMessageMock.mockClear();
  });

  it("keeps inbound context finalized", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectChannelInboundContextContract(capture.ctx!);
  });
});
