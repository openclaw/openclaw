import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn().mockResolvedValue({ queuedFinal: false }),
}));

import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { sendReactionSignal } from "../send-reactions.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

function makeDeps(cfgOverrides: Record<string, unknown> = {}) {
  const accountOverrides = (cfgOverrides.accountOverrides as Record<string, unknown>) ?? undefined;
  const messagesOverrides = (cfgOverrides.messages as Record<string, unknown>) ?? undefined;
  return createBaseSignalEventHandlerDeps({
    cfg: {
      channels: {
        signal: {
          accounts: {
            default: {
              reactionLevel: "ack",
              ...accountOverrides,
            },
          },
        },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
        ...messagesOverrides,
      },
      ...cfgOverrides,
    },
    ignoreAttachments: true,
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return createSignalReceiveEvent({
    dataMessage: { message: "hello", timestamp: 1700000000000 },
    ...overrides,
  });
}

describe("Signal ACK reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends ack reaction for DM when reactionLevel=ack and scope=direct", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "direct" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends ack reaction for DM when scope=all", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).toHaveBeenCalledOnce();
  });

  it("sends ack reaction for group when scope=all", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      makeEvent({
        dataMessage: {
          message: "hello group",
          timestamp: 1700000000000,
          groupInfo: { groupId: "grp123", groupName: "Test Group" },
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({ groupId: "grp123" }),
    );
  });

  it("sends ack reaction for group when scope=group-all", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "group-all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      makeEvent({
        dataMessage: {
          message: "hello group",
          timestamp: 1700000000000,
          groupInfo: { groupId: "grp123", groupName: "Test Group" },
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalledOnce();
  });

  it("does NOT send ack when scope=off", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "off" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack for group when scope=group-mentions and not mentioned", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      makeEvent({
        dataMessage: {
          message: "hello group no mention",
          timestamp: 1700000000000,
          groupInfo: { groupId: "grp123", groupName: "Test Group" },
        },
      }),
    );

    // group-mentions requires a mention pattern match — no mention patterns configured so no ack
    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack when reactionLevel=minimal", async () => {
    const deps = makeDeps({
      accountOverrides: { reactionLevel: "minimal" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack when reactionLevel=off", async () => {
    const deps = makeDeps({
      accountOverrides: { reactionLevel: "off" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack when timestamp is missing", async () => {
    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(
      makeEvent({
        timestamp: undefined,
        dataMessage: { message: "hello", timestamp: 1700000000000 },
      }),
    );

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("sends ack BEFORE dispatch", async () => {
    const callOrder: string[] = [];
    vi.mocked(sendReactionSignal).mockImplementation(async () => {
      callOrder.push("ack");
      return { ok: true };
    });
    vi.mocked(dispatchInboundMessage).mockImplementation(async () => {
      callOrder.push("dispatch");
      return { queuedFinal: false } as ReturnType<typeof dispatchInboundMessage> extends Promise<
        infer T
      >
        ? T
        : never;
    });

    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(callOrder[0]).toBe("ack");
    expect(callOrder).toContain("dispatch");
  });
});
