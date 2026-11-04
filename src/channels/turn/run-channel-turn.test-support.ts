import { vi } from "vitest";

const mocks = vi.hoisted(() => {
  const emitMessageSent = vi.fn();
  return {
    deliverOutboundPayloads: vi.fn(),
    resolveOutboundDurableFinalDeliverySupport: vi.fn(),
    sendDurableMessageBatch: vi.fn(),
    recordInboundSessionCore: vi.fn(async () => undefined),
    dispatchReplyWithBufferedBlockDispatcherCore: vi.fn(),
    dispatchReplyWithRoutedChannelDispatcherCore: vi.fn(),
    emitMessageSent,
    getGlobalHookRunner: vi.fn(),
    createMessageSentEmitter: vi.fn(() => ({ emitMessageSent, hasMessageSentHooks: true })),
    readRecentUserAssistantTextForSession: vi.fn(),
  };
});

export { mocks as channelTurnMocks };

vi.mock("../../auto-reply/reply/provider-dispatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/reply/provider-dispatcher.js")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcherCore:
      mocks.dispatchReplyWithBufferedBlockDispatcherCore,
  };
});

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher:
      mocks.dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return {
    ...actual,
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    resolveOutboundDurableFinalDeliverySupport: mocks.resolveOutboundDurableFinalDeliverySupport,
  };
});

vi.mock("../message/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../message/send.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: mocks.sendDurableMessageBatch,
  };
});

vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: mocks.recordInboundSessionCore };
});

vi.mock("../../infra/outbound/message-sent-hook.js", () => ({
  createMessageSentEmitter: mocks.createMessageSentEmitter,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner: mocks.getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: mocks.readRecentUserAssistantTextForSession,
}));
