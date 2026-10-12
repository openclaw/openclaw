import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import type * as ConfirmedVisibleMessage from "../../sessions/background-session-result.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { executeSendAction } from "./outbound-send-service.js";

const mocks = vi.hoisted(() => ({
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
  dispatchChannelMessageAction: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("../../sessions/background-session-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: mocks.commitConfirmedVisibleMessage,
}));

vi.mock("./message.js", () => ({ sendMessage: mocks.sendMessage }));

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");
type ExecuteSendContext = Parameters<OutboundSendServiceModule["executeSendAction"]>[0]["ctx"];

const plugin = createChannelTestPluginBase({ id: "demo-outbound" });

function createContext(overrides: Partial<ExecuteSendContext>): ExecuteSendContext {
  const cfg = overrides.cfg ?? {};
  const params = overrides.params ?? { to: "channel:123", message: "delivered" };
  return {
    channelPlugin: plugin,
    channel: plugin.id,
    dryRun: false,
    ...overrides,
    cfg,
    params,
    input: { cfg, action: "send", params, ...overrides.input },
  };
}

describe("accepted plugin delivery outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits an accepted partial plugin send without mirroring unproven content", async () => {
    const onSendAccepted = vi.fn(async () => {});
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("second part failed"), {
        messageIds: ["msg-plugin"],
        visibleReplySent: true,
      }),
    );

    await expect(
      executeSendAction({
        ctx: createContext({
          onSendAccepted,
        }),
        to: "channel:123",
        message: "accepted then unsent",
      }),
    ).rejects.toThrow("second part failed");

    expect(onSendAccepted).toHaveBeenCalledOnce();
    expect(mocks.commitConfirmedVisibleMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("commits a returned partial plugin send without mirroring unproven content", async () => {
    const onSendAccepted = vi.fn(async () => {});
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
      content: [],
      details: {
        deliveryStatus: "partial_failed",
        sentBeforeError: true,
        error: "second part failed",
        messageId: "msg-plugin",
      },
    });

    const result = await executeSendAction({
      ctx: createContext({
        onSendAccepted,
      }),
      to: "channel:123",
      message: "accepted then unsent",
    });

    expect(result).toMatchObject({
      handledBy: "plugin",
      payload: { deliveryStatus: "partial_failed", sentBeforeError: true },
    });
    expect(onSendAccepted).toHaveBeenCalledOnce();
    expect(mocks.commitConfirmedVisibleMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["failed", "pending", "unknown"])(
    "does not commit unconfirmed plugin status %s",
    async (deliveryStatus) => {
      mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
        content: [],
        details: { deliveryStatus },
      });
      await executeSendAction({
        ctx: createContext({}),
        to: "channel:123",
        message: "unconfirmed",
      });
      expect(mocks.commitConfirmedVisibleMessage).not.toHaveBeenCalled();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([["created-thread"], ["created-thread", "another-thread"]])(
    "uses only an unambiguous native receipt thread: %j",
    async (...threadIds) => {
      const receipt = createMessageReceiptFromOutboundResults({
        results: [{ channel: "demo-outbound", messageId: "thread-message" }],
        threadId: threadIds[0],
      });
      receipt.parts = threadIds.map((threadId, index) => ({
        platformMessageId: `thread-message-${index}`,
        kind: "text",
        index,
        threadId,
      }));
      mocks.dispatchChannelMessageAction.mockResolvedValue({
        content: [],
        details: { messageId: "thread-message", receipt },
      });
      await expect(
        executeSendAction({
          ctx: createContext({
            transcriptRoute: {
              sessionKey: "agent:main:demo-outbound:channel:123:thread:prepared-thread",
              baseSessionKey: "agent:main:demo-outbound:channel:123",
              peer: { kind: "channel", id: "123" },
              chatType: "channel",
              from: "demo-outbound:channel:123",
              to: "channel:123",
              threadId: "prepared-thread",
            },
          }),
          to: "channel:123",
          message: "native thread reply",
          threadId: "prepared-thread",
        }),
      ).resolves.toMatchObject({ handledBy: "plugin" });
      if (threadIds.length > 1) {
        expect(mocks.commitConfirmedVisibleMessage).not.toHaveBeenCalled();
      } else {
        expect(mocks.commitConfirmedVisibleMessage).toHaveBeenCalledOnce();
        expect(mocks.commitConfirmedVisibleMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "created-thread",
            route: undefined,
            payload: expect.objectContaining({ text: "native thread reply" }),
          }),
        );
      }
    },
  );
});
