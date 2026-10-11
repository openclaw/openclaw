import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
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

vi.mock("../../sessions/confirmed-visible-message.js", () => ({
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
});
