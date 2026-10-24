import { beforeEach, expect, it, vi } from "vitest";
import { createChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { executeSendAction } from "./outbound-send-service.js";

const mocks = vi.hoisted(() => ({
  commitConfirmedVisibleMessage: vi.fn(),
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

const plugin = createChannelTestPluginBase({ id: "demo-outbound" });
const onSendAccepted = vi.fn(async () => {});
function send() {
  const cfg = {};
  const params = { to: "channel:123", message: "delivered" };
  return executeSendAction({
    ctx: {
      channelPlugin: plugin,
      channel: plugin.id,
      dryRun: false,
      cfg,
      params,
      input: { cfg, action: "send", params },
      onSendAccepted,
    },
    to: "channel:123",
    message: "accepted then unsent",
  });
}

beforeEach(() => vi.clearAllMocks());
it.each(["thrown", "returned"])(
  "commits %s partial plugin delivery without recording unproven content",
  async (mode) => {
    if (mode === "thrown") {
      mocks.dispatchChannelMessageAction.mockRejectedValueOnce(
        createChannelPartialDeliveryError(new Error("second part failed"), {
          messageIds: ["msg-plugin"],
          visibleReplySent: true,
        }),
      );
      await expect(send()).rejects.toThrow("second part failed");
    } else {
      mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
        content: [],
        details: {
          deliveryStatus: "partial_failed",
          sentBeforeError: true,
          error: "second part failed",
          messageId: "msg-plugin",
        },
      });
      await expect(send()).resolves.toMatchObject({
        handledBy: "plugin",
        payload: { deliveryStatus: "partial_failed", sentBeforeError: true },
      });
    }
    expect(onSendAccepted).toHaveBeenCalledOnce();
    expect(mocks.commitConfirmedVisibleMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  },
);
