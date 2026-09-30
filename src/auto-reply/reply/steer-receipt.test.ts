import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";
import { armSteerReceiptEvictionNotice, sendSteerReceipt } from "./steer-receipt.js";

const STEERED = "🦞🛞 Current run steered with your new message.";
const QUEUED = "⏳ Couldn't steer the current run; your message is queued behind it.";
const EVICTED =
  "⚠️ This message was dropped from the queue when newer messages overflowed it. Please send it again once the run finishes.";

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, delivered: true, messageId: "900" })),
  isRoutableChannel: vi.fn((channel: string) => channel === "telegram"),
}));
vi.mock("./route-reply.runtime.js", () => routeMocks);

function makeRun(overrides: Partial<FollowupRun> = {}, steerReceipts?: boolean): FollowupRun {
  const config = {
    messages: { queue: steerReceipts === undefined ? {} : { steerReceipts } },
  } as OpenClawConfig;
  return {
    prompt: "change of plan",
    enqueuedAt: 0,
    messageId: "42",
    originatingChannel: "telegram",
    originatingTo: "-100123",
    originatingThreadId: 7,
    originatingAccountId: "default",
    run: {
      agentId: "main",
      provider: "anthropic",
      model: "claude-opus-5-5",
      sessionKey: "agent:main:telegram:group:-100123:topic:7",
      senderId: "111",
      config,
    },
    ...overrides,
  } as unknown as FollowupRun;
}

describe("steer receipts", () => {
  beforeEach(() => {
    routeMocks.routeReply.mockClear();
  });

  it("is off unless messages.queue.steerReceipts is true", async () => {
    await sendSteerReceipt({ followupRun: makeRun(), kind: "steered" });
    await sendSteerReceipt({ followupRun: makeRun({}, false), kind: "queued" });
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
  });

  it("replies to the steered message without mirroring it into the transcript", async () => {
    await sendSteerReceipt({ followupRun: makeRun({}, true), kind: "steered" });
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: STEERED, replyToCurrent: true, replyToId: "42" },
        channel: "telegram",
        to: "-100123",
        threadId: 7,
        accountId: "default",
        currentMessageId: "42",
        mirror: false,
        replyKind: "tool",
        responsePrefixContext: expect.objectContaining({
          modelFull: "anthropic/claude-opus-5-5",
          model: "claude-opus-5-5",
        }),
      }),
    );
  });

  it("quotes the steered message even when the queued run carries no message id", async () => {
    await sendSteerReceipt({
      followupRun: makeRun({ messageId: undefined }, true),
      kind: "steered",
      sourceMessageId: "52",
    });
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageId: "52",
        payload: expect.objectContaining({ replyToId: "52" }),
      }),
    );
  });

  it("tells the sender when the message will wait for its own turn", async () => {
    await sendSteerReceipt({ followupRun: makeRun({}, true), kind: "queued" });
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: QUEUED, replyToCurrent: true, replyToId: "42" } }),
    );
  });

  it.each([
    ["queued", "queued behind it"],
    ["at-cap", "may still be folded into a summary or dropped"],
    ["summarized", "older summary entries can be trimmed"],
    ["dropped", "was dropped. Please send it again"],
  ] as const)("does not promise an answer for a %s fallback", async (kind, fragment) => {
    await sendSteerReceipt({ followupRun: makeRun({}, true), kind });
    const call = routeMocks.routeReply.mock.calls[0] as unknown as [{ payload: { text: string } }];
    expect(call[0].payload.text).toContain(fragment);
    expect(call[0].payload.text).not.toMatch(/I'll answer/);
  });

  it("follows up once, after the fallback receipt, when a later overflow evicts the message", async () => {
    const observed = vi.fn();
    const run = makeRun({ messageId: undefined, onQueueDisposition: observed }, true);
    const order: string[] = [];
    routeMocks.routeReply.mockImplementation(async (...args: unknown[]) => {
      order.push((args[0] as { payload: { text: string } }).payload.text);
      return { ok: true, delivered: true, messageId: "901" };
    });
    const receipt = sendSteerReceipt({ followupRun: run, kind: "queued", sourceMessageId: "52" });
    armSteerReceiptEvictionNotice({ followupRun: run, sourceMessageId: "52", after: receipt });
    run.onQueueDisposition?.("queue-cap-old");
    run.onQueueDisposition?.("queue-cap-old");
    await receipt;
    await vi.waitFor(() => expect(order).toEqual([QUEUED, EVICTED]));
    expect(observed.mock.calls).toEqual([["queue-cap-old"], ["queue-cap-old"]]);
    expect(routeMocks.routeReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentMessageId: "52",
        payload: expect.objectContaining({ text: EVICTED, replyToId: "52" }),
      }),
    );
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "900" });
  });

  it("does not arm the eviction notice when receipts are off, and ignores other dispositions", async () => {
    const off = makeRun({}, false);
    armSteerReceiptEvictionNotice({ followupRun: off });
    expect(off.onQueueDisposition).toBeUndefined();
    const on = makeRun({}, true);
    armSteerReceiptEvictionNotice({ followupRun: on });
    on.onQueueDisposition?.("queue-cap");
    on.onQueueDisposition?.("queue-cap-new");
    await Promise.resolve();
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
  });

  it("stays silent for ambient room events and unroutable origins", async () => {
    await sendSteerReceipt({
      followupRun: makeRun({ currentInboundEventKind: "room_event" }, true),
      kind: "steered",
    });
    await sendSteerReceipt({
      followupRun: makeRun({ originatingChannel: "webchat" as never }, true),
      kind: "steered",
    });
    await sendSteerReceipt({
      followupRun: makeRun({ originatingTo: undefined }, true),
      kind: "queued",
    });
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
  });

  it("never throws when delivery fails", async () => {
    routeMocks.routeReply.mockRejectedValueOnce(new Error("telegram down"));
    await expect(
      sendSteerReceipt({ followupRun: makeRun({}, true), kind: "steered" }),
    ).resolves.toBeUndefined();
  });
});
