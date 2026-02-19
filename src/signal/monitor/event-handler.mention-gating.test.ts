import { describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../test/helpers/dispatch-inbound-capture.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned"> & {
  Body?: string;
  WasMentioned?: boolean;
};

let capturedCtx: SignalMsgContext | undefined;

function getCapturedCtx() {
  return capturedCtx as SignalMsgContext;
}

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as SignalMsgContext;
  });
});

import { createSignalEventHandler } from "./event-handler.js";
import { renderSignalMentions } from "./mentions.js";

type GroupEventOpts = {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
  mentions?: Array<{
    uuid?: string;
    number?: string;
    start?: number;
    length?: number;
  }> | null;
};

function makeGroupEvent(opts: GroupEventOpts) {
  return createSignalReceiveEvent({
    dataMessage: {
      message: opts.message ?? "",
      attachments: opts.attachments ?? [],
      quote: opts.quoteText ? { text: opts.quoteText } : undefined,
      mentions: opts.mentions ?? undefined,
      groupInfo: { groupId: "g1", groupName: "Test Group" },
    },
  });
}

function createMentionHandler(params: {
  requireMention: boolean;
  mentionPattern?: string;
  historyLimit?: number;
  groupHistories?: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"];
}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({
        requireMention: params.requireMention,
        mentionPattern: params.mentionPattern,
      }),
      ...(typeof params.historyLimit === "number" ? { historyLimit: params.historyLimit } : {}),
      ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    }),
  );
}

function createMentionGatedHistoryHandler() {
  const groupHistories = new Map();
  const handler = createMentionHandler({ requireMention: true, historyLimit: 5, groupHistories });
  return { handler, groupHistories };
}

function createSignalConfig(params: { requireMention: boolean; mentionPattern?: string }) {
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns: [params.mentionPattern ?? "@bot"] },
    },
    channels: {
      signal: {
        groups: { "*": { requireMention: params.requireMention } },
      },
    },
  } as unknown as OpenClawConfig;
}

async function expectSkippedGroupHistory(opts: GroupEventOpts, expectedBody: string) {
  capturedCtx = undefined;
  const { handler, groupHistories } = createMentionGatedHistoryHandler();
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = groupHistories.get("g1");
  expect(entries).toBeTruthy();
  expect(entries).toHaveLength(1);
  expect(entries[0].body).toBe(expectedBody);
}

describe("signal mention gating", () => {
  it("drops group messages without mention when requireMention is configured", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeUndefined();
  });

  it("allows group messages with mention when requireMention is configured", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hey @bot what's up" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("sets WasMentioned=false for group messages without mention when requireMention is off", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({ requireMention: false });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(false);
  });

  it("records pending history for skipped group messages", async () => {
    capturedCtx = undefined;
    const { handler, groupHistories } = createMentionGatedHistoryHandler();
    await handler(makeGroupEvent({ message: "hello from alice" }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].sender).toBe("Alice");
    expect(entries[0].body).toBe("hello from alice");
  });

  it("records attachment placeholder in pending history for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }] },
      "<media:attachment>",
    );
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it("bypasses mention gating for authorized control commands", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "/help" }));
    expect(capturedCtx).toBeTruthy();
  });

  it("hydrates mention placeholders before trimming so offsets stay aligned", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({ requireMention: false });

    const placeholder = "\uFFFC";
    const message = `\n${placeholder} hi ${placeholder}`;
    const firstStart = message.indexOf(placeholder);
    const secondStart = message.indexOf(placeholder, firstStart + 1);

    await handler(
      makeGroupEvent({
        message,
        mentions: [
          { uuid: "123e4567", start: firstStart, length: placeholder.length },
          { number: "+15550002222", start: secondStart, length: placeholder.length },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    const body = String(getCapturedCtx()?.Body ?? "");
    expect(body).toContain("@123e4567 hi @+15550002222");
    expect(body).not.toContain(placeholder);
  });

  it("counts mention metadata replacements toward requireMention gating", async () => {
    capturedCtx = undefined;
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: "@123e4567",
    });

    const placeholder = "\uFFFC";
    const message = ` ${placeholder} ping`;
    const start = message.indexOf(placeholder);

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ uuid: "123e4567", start, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(String(getCapturedCtx()?.Body ?? "")).toContain("@123e4567");
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });
});

describe("renderSignalMentions", () => {
  const PLACEHOLDER = "\uFFFC";

  it("returns the original message when no mentions are provided", () => {
    const message = `${PLACEHOLDER} ping`;
    expect(renderSignalMentions(message, null)).toBe(message);
    expect(renderSignalMentions(message, [])).toBe(message);
  });

  it("replaces placeholder code points using mention metadata", () => {
    const message = `${PLACEHOLDER} hi ${PLACEHOLDER}!`;
    const normalized = renderSignalMentions(message, [
      { uuid: "abc-123", start: 0, length: 1 },
      { number: "+15550005555", start: message.lastIndexOf(PLACEHOLDER), length: 1 },
    ]);

    expect(normalized).toBe("@abc-123 hi @+15550005555!");
  });

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const normalized = renderSignalMentions(message, [
      { name: "ignored" },
      { uuid: "valid", start: 0, length: 1 },
      { number: "+1555", start: 999, length: 1 },
    ]);

    expect(normalized).toBe("@valid hi");
  });

  it("clamps and truncates fractional mention offsets", () => {
    const message = `${PLACEHOLDER} ping`;
    const normalized = renderSignalMentions(message, [{ uuid: "valid", start: -0.7, length: 1.9 }]);

    expect(normalized).toBe("@valid ping");
  });
});
