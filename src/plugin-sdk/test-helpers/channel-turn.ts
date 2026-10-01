import { vi } from "vitest";

// Own these module spies for one sequential test. Refuse nested fixtures so
// restoring them cannot remove another fixture's mocks.
export async function createChannelTurnTestMocks() {
  const [dispatch, session, durableDelivery] = await Promise.all([
    import("../../auto-reply/dispatch.js"),
    import("../../channels/session.js"),
    import("../../channels/turn/durable-delivery.js"),
  ]);
  if (
    [
      dispatch.dispatchInboundMessageWithRoutedChannelDispatcher,
      session.recordInboundSession,
      durableDelivery.deliverInboundReplyWithMessageSendContextCore,
    ].some((target) => vi.isMockFunction(target))
  ) {
    throw new Error("Channel turn test owners are already mocked; restore their fixture first.");
  }
  const dispatchAgentReplyMock = vi.spyOn(
    dispatch,
    "dispatchInboundMessageWithRoutedChannelDispatcher",
  );
  const recordInboundSessionMock = vi.spyOn(session, "recordInboundSession");
  const deliverInboundReplyWithMessageSendContextMock = vi.spyOn(
    durableDelivery,
    "deliverInboundReplyWithMessageSendContextCore",
  );
  return {
    dispatchAgentReplyMock,
    recordInboundSessionMock,
    deliverInboundReplyWithMessageSendContextMock,
    restore() {
      deliverInboundReplyWithMessageSendContextMock.mockRestore();
      recordInboundSessionMock.mockRestore();
      dispatchAgentReplyMock.mockRestore();
    },
  };
}
