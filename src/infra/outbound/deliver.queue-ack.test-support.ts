import { expect, it, vi, type Mock } from "vitest";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendResult,
} from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.adapters.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

type OutboundTextSender = NonNullable<ChannelOutboundAdapter["sendText"]>;

type QueueAckFixture = {
  queueMocks: Record<
    | "ackDelivery"
    | "failDelivery"
    | "failDeliveryAfterPlatformSend"
    | "markDeliveryPlatformOutcomeUnknown",
    Mock<(...args: unknown[]) => Promise<void>>
  >;
  hookMocks: {
    runner: {
      hasHooks: Mock<(hookName?: string) => boolean>;
      runMessageSent: Mock<(event: unknown, context: unknown) => Promise<void>>;
    };
  };
  deliverMatrix: (
    params: Pick<DeliverOutboundPayloadsParams, "payloads" | "deps" | "bestEffort" | "queuePolicy">,
  ) => Promise<OutboundDeliveryResult[]>;
  setTestOutbound: (overrides: Partial<ChannelOutboundAdapter>) => void;
  setMatrixMessageAdapter: (message: ChannelMessageAdapterShape) => void;
  createMatrixMessageSendResult: (messageId: string) => ChannelMessageSendResult;
};

// Register inside the owning suite so its hoisted mocks and reset order remain authoritative.
export function registerOutboundQueueAckTests({
  queueMocks,
  hookMocks,
  deliverMatrix,
  setTestOutbound,
  setMatrixMessageAdapter,
  createMatrixMessageSendResult,
}: QueueAckFixture) {
  it("runs sent-result commit hooks when marker fallback ack precedes a partial failure", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    const afterCommit = vi.fn();
    const messageSendText = vi
      .fn()
      .mockResolvedValueOnce(createMatrixMessageSendResult("message-adapter-1"))
      .mockRejectedValueOnce(new Error("second send failed"));
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { capabilities: { text: true, afterCommit: true } },
      send: { lifecycle: { afterCommit }, text: messageSendText },
    });

    const results = await deliverMatrix({
      payloads: [{ text: "first" }, { text: "second" }],
      bestEffort: true,
      queuePolicy: "required",
    });

    expect(results).toHaveLength(1);
    expect(queueMocks.ackDelivery).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("emits message_sent after fallback ACK for identityless partial delivery", async () => {
    const order: string[] = [];
    hookMocks.runner.hasHooks.mockImplementation((name) => name === "message_sent");
    hookMocks.runner.runMessageSent.mockImplementation(async () => {
      order.push("message_sent");
    });
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockImplementationOnce(async () => {
      order.push("mark-unknown");
      throw new Error("unknown marker offline");
    });
    queueMocks.ackDelivery.mockImplementationOnce(async () => {
      order.push("ack");
    });
    const sendText = vi
      .fn<OutboundTextSender>()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "" })
      .mockRejectedValueOnce(new Error("second send failed"));
    setTestOutbound({ sendText });

    const results = await deliverMatrix({
      payloads: [{ text: "identityless first payload" }, { text: "failed second payload" }],
      bestEffort: true,
      queuePolicy: "required",
    });

    expect(results).toEqual([]);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).toHaveBeenCalledOnce();
    expect(queueMocks.ackDelivery).toHaveBeenCalledOnce();
    expect(order).toEqual(["mark-unknown", "ack", "message_sent", "message_sent"]);
    expect(hookMocks.runner.runMessageSent.mock.calls.map(([event]) => event)).toMatchObject([
      { content: "identityless first payload", success: false },
      { content: "failed second payload", success: false, error: "second send failed" },
    ]);
  });

  it("retains unknown-after-send evidence when both the marker and direct ack fail", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    queueMocks.ackDelivery.mockRejectedValueOnce(new Error("ack offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await deliverMatrix({
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    });

    expect(queueMocks.failDeliveryAfterPlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("marker=unknown marker offline; ack=ack offline"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("fails required delivery when queue ack fails after platform send", async () => {
    queueMocks.ackDelivery.mockRejectedValueOnce(new Error("ack offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await expect(
      deliverMatrix({
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ack offline");

    expect(sendMatrix).toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDeliveryAfterPlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("failed to ack sent delivery: ack offline"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });
}
