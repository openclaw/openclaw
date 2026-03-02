import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { dispatchInboundMessageMock, capture } = vi.hoisted(() => {
  const captureState: { ctx: MsgContext | undefined } = { ctx: undefined };
  return {
    dispatchInboundMessageMock: vi.fn(
      async (params: {
        ctx: MsgContext;
        replyOptions?: { onReplyStart?: () => void | Promise<void> };
      }) => {
        captureState.ctx = params.ctx;
        await Promise.resolve(params.replyOptions?.onReplyStart?.());
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    ),
    capture: captureState,
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(),
  sendReadReceiptSignal: vi.fn(),
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

import { createSignalEventHandler } from "./event-handler.js";

describe("signal group update / system message filtering", () => {
  beforeEach(() => {
    capture.ctx = undefined;
    dispatchInboundMessageMock.mockClear();
  });

  it("filters out group permission change messages (groupInfo.type=UPDATE)", async () => {
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
          message: "Admin settings changed: only admins can edit group info",
          groupInfo: { groupId: "g1", groupName: "Test Group", type: "UPDATE" },
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(capture.ctx).toBeUndefined();
  });

  it("filters out group update messages with no message text", async () => {
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
          message: null,
          groupInfo: { groupId: "g1", groupName: "Test Group", type: "UPDATE" },
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("filters out expiration timer update messages", async () => {
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
          message: null,
          expiresInSeconds: 2419200,
          isExpirationUpdate: true,
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(capture.ctx).toBeUndefined();
  });

  it("still delivers normal group messages with groupInfo.type=DELIVER", async () => {
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
          message: "Hello everyone!",
          groupInfo: { groupId: "g1", groupName: "Test Group", type: "DELIVER" },
        },
      }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    expect(capture.ctx).toBeTruthy();
  });

  it("still delivers normal group messages without groupInfo.type", async () => {
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
          message: "Hello!",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    expect(capture.ctx).toBeTruthy();
  });

  it("still delivers direct messages with expiresInSeconds but no isExpirationUpdate", async () => {
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
          message: "This is a timed message",
          expiresInSeconds: 3600,
        },
      }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    expect(capture.ctx).toBeTruthy();
  });
});
