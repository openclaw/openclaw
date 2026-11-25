import { describe, expect, it, vi } from "vitest";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import { expectText } from "../test-utils/text-assertions.js";
import { formatMessageCliText } from "./message-format.js";

const getChannelPluginMock = vi.hoisted(() =>
  vi.fn((channel: string) => {
    const labels: Record<string, string> = { directchat: "Direct Chat", alpha: "Alpha" };
    const label = labels[channel];
    return label ? { meta: { label } } : undefined;
  }),
);

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  getLoadedChannelPlugin: getChannelPluginMock,
}));

type ActionResult = Extract<MessageActionResult, { kind: "action" }>;
type SendResult = Extract<MessageActionResult, { kind: "send" }>;
type BroadcastResult = Extract<MessageActionResult, { kind: "broadcast" }>;

function actionResult(
  action: ActionResult["action"],
  payload: unknown,
  channel = "matrix",
): ActionResult {
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload,
    dryRun: false,
  };
}
const readResultPayload = (payload: unknown) => actionResult("read", payload);
const pinsResultPayload = (payload: unknown) => actionResult("list-pins", payload);
const searchResultPayload = (payload: unknown) => actionResult("search", payload, "discord");

function sendResult(
  send: SendResult["sendResult"],
  overrides: Partial<SendResult> = {},
): SendResult {
  return {
    kind: "send",
    action: "send",
    channel: "directchat",
    to: "room-1",
    handledBy: "core",
    payload: {},
    dryRun: false,
    sendResult: send,
    ...overrides,
  };
}
function broadcastResult(
  results: BroadcastResult["payload"]["results"],
  channel = "directchat",
): BroadcastResult {
  return {
    kind: "broadcast",
    action: "broadcast",
    channel,
    handledBy: "core",
    payload: { results },
    dryRun: false,
  };
}

function msg(id: string, ts: string, authorTag: string, content: string) {
  return { id, ts, authorTag, content };
}

function render(result: MessageActionResult, options?: Parameters<typeof formatMessageCliText>[1]) {
  return formatMessageCliText(result, options).join("\n");
}

describe("formatMessageCliText displayLimit", () => {
  it("keeps a whitespace-only primary message instead of selecting its fallback", () => {
    const result = readResultPayload({
      messages: [{ id: "message-id", content: "  ", text: "Wrong fallback" }],
    });
    const output = render(result);
    expect(output).toContain("message-id");
    expect(output).not.toContain("Wrong fallback");
  });

  it.each(["discord", "slack"] as const)(
    "preserves flat %s pins and their outer identity",
    (channel) => {
      const pin = { id: "pin-resource", messageId: "message-id", text: "Flat pin" };
      const output = render({ ...pinsResultPayload({ pins: [pin] }), channel });
      expect(output).toContain("pin-resource");
      expect(output).toContain("Flat pin");
    },
  );

  it("renders an empty Slack pin list", () => {
    const result = { ...pinsResultPayload({ pins: [] }), channel: "slack" as const };
    expect(formatMessageCliText(result)).toEqual(["Pinned messages", "No pins."]);
  });

  it("defaults to 50 reaction rows", () => {
    const reactions = Array.from({ length: 51 }, (_, index) => ({
      name: `reaction-${String(index).padStart(2, "0")}`,
      count: index + 1,
    }));
    const result = actionResult("reactions", { reactions });

    const output = render(result);

    expect(output).toContain("reaction-49");
    expect(output).not.toContain("reaction-50");
  });

  it("renders an explicit empty search outcome despite an approximate positive total", () => {
    const result = searchResultPayload({ results: { messages: [], total_results: 1 } });
    expect(formatMessageCliText(result)).toEqual(["Search results", "No results."]);
  });
});

describe("formatMessageCliText message terminal safety", () => {
  const text = "\u001b[2Jrelease checklist\u001b]52;c;QQ==\u0007";
  const author = "\u001b]52;c;QQ==\u0007alice";
  const timestamp = "\u001b[2J1712345678.123456";
  const slackMessage = { ts: timestamp, user: author, text };
  const message = {
    id: "\u001b[2Jmessage-1",
    timestamp,
    author: { username: author },
    content: text,
  };

  it.each([
    {
      surface: "nested Slack pins",
      result: {
        ...pinsResultPayload({
          pins: [
            { created_by: "pinning-user", message: slackMessage },
            { message: { text: "Outside display limit" } },
          ],
        }),
        channel: "slack" as const,
      },
      id: "1712345678.123456",
    },
    { surface: "Matrix read", result: readResultPayload({ messages: [message] }), id: "message-1" },
    {
      surface: "Matrix pins",
      result: pinsResultPayload({ pins: [message, { text: "Outside display limit" }] }),
      id: "message-1",
    },
    {
      surface: "Discord search",
      result: searchResultPayload({ results: { messages: [[message]] } }),
      id: "message-1",
    },
  ])("renders $surface as terminal-safe text without mutating the payload", ({ result, id }) => {
    const original = structuredClone(result.payload);

    const output = render(result, { displayLimit: 1 });

    expectText(output, ["release checklist", "alice", id, "1712345678.123456"]);
    expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
    expect(output).not.toContain("52;c;QQ==");
    expectText(output, [], ["pinning-user", "Outside display limit"]);
    expect(result.payload).toEqual(original);
  });
});

describe("formatMessageCliText reaction labels", () => {
  const label = "\u001b[2J:party_parrot:🦞\nline";
  it("renders the preferred name label as plain text without changing the payload", () => {
    const reaction = { name: label, emoji: "unused-emoji", key: "unused-key" };
    const result = actionResult("reactions", {
      reactions: [{ ...reaction, count: 2, users: ["\u001b[31malice\u001b[0m", "bob\tother"] }],
    });
    const payload = structuredClone(result.payload);
    const output = render(result);
    expect(result.payload).toEqual(payload);
    expectText(
      output,
      [":party_parrot:🦞\\nline", "alice", "bob\\tother"],
      ["\u001b[2J", "unused-"],
    );
    expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  });
});

describe("renderPaginationHint", () => {
  it.each([
    { nextBatch: "token-123" },
    { "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" },
  ])("emits a hint for provider continuation %j", (continuation) => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages, ...continuation });
    expect(render(result, { displayLimit: 5 })).toContain("More results available");
  });

  it.each([0, 1])("preserves explicit search continuation with %i returned messages", (count) => {
    const messages = Array.from({ length: count }, (_, index) =>
      msg(`id-${index}`, "2026-01-01T00:00:00.000Z", "alice", "hello"),
    );
    const result = searchResultPayload({
      results: { messages: messages.map((message) => [message]), hasMore: true },
    });

    expect(render(result, { displayLimit: 5 })).toContain("More results available");
  });
});

describe("formatMessageCliText send results", () => {
  it.each([
    ["direct", "alpha", undefined, "✅ Sent via Alpha. Message ID: unknown"],
    ["gateway", "", undefined, "✅ Sent via gateway. Message ID: unknown"],
    [
      "direct",
      "alpha",
      {
        channel: "alpha",
        messageId: "m\u001b[2J1",
        target: { kind: "chat", id: "c\u001b[31m1\u001b[0m" },
      },
      "✅ Sent via Alpha. Message ID: m1 (chat c1)",
    ],
    [
      "gateway",
      "directchat",
      { messageId: "\u001b]8;;https://example.invalid\u0007m1\u001b]8;;\u0007" },
      "✅ Sent via gateway (directchat). Message ID: m1",
    ],
  ] as const)("formats core %s send results for '%s'", (via, channel, result, expected) => {
    const delivery = sendResult(
      { channel, to: "c1", via, mediaUrl: null, result },
      { channel: "alpha", to: "c1" },
    );
    expect(formatMessageCliText(delivery)).toEqual([expected]);
  });

  it("prefers and trims a direct plugin payload message ID", () => {
    const result = sendResult(undefined, {
      handledBy: "plugin",
      payload: {
        messageId: " direct-id ",
        result: { messageId: "nested-id" },
      },
    });

    expect(formatMessageCliText(result)).toEqual([
      "✅ Sent via Direct Chat. Message ID: direct-id",
    ]);
  });

  it("reports a partial delivery failure without claiming success", () => {
    const result = sendResult({
      channel: "directchat",
      to: "room-1",
      via: "direct",
      mediaUrl: null,
      deliveryStatus: "partial_failed",
      error: "second attachment rejected",
      result: { channel: "directchat", messageId: "first-part-1" },
    });
    const output = render(result);
    expect(output).toContain("second attachment rejected");
    expect(output).not.toContain("✅ Sent");
    expect(output).toContain("Message ID: first-part-1");
  });
});

it("preserves generic object primitive summaries", () => {
  const result = actionResult(
    "channel-info",
    {
      undef: undefined,
      nil: null,
      array: [1, 2],
      object: {},
      function: () => undefined,
      bigint: 42n,
      symbol: Symbol("proof"),
      string: "  keep  ",
      number: -3,
      boolean: false,
    },
    "directchat",
  );

  const output = render(result);
  expectText(output, [
    "null",
    "2 items",
    "object",
    "function",
    "42",
    "Symbol(proof)",
    "keep",
    "-3",
    "false",
  ]);
});

it("reports a rejected poll without claiming success", () => {
  const result: MessageActionResult = {
    kind: "poll",
    channel: "telegram",
    action: "poll",
    to: "123",
    handledBy: "plugin",
    payload: { ok: false, error: "Poll rejected" },
    dryRun: false,
  };

  const output = render(result);

  expect(output).toContain("Poll rejected");
  expect(output).not.toContain("✅");
});

it.each(["direct", "gateway"] as const)(
  "preserves %s poll summaries with missing and optional result fields",
  (via) => {
    for (const [delivery, messageId, pollLine] of [
      [undefined, "unknown", []],
      [{ messageId: "p1" }, "p1", []],
      [{ messageId: "p1", pollId: "poll-1" }, "p1", ["Poll id: poll-1"]],
      [{ messageId: "", pollId: "" }, "", []],
    ] as const) {
      const result = {
        kind: "poll",
        action: "poll",
        channel: "directchat",
        to: "room-1",
        handledBy: "core",
        payload: {},
        dryRun: false,
        pollResult: {
          channel: "directchat",
          to: "room-1",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 1,
          durationSeconds: null,
          durationHours: null,
          via,
          result: delivery,
        },
      } satisfies MessageActionResult;

      expect(formatMessageCliText(result)).toEqual([
        via === "direct"
          ? `✅ Poll sent via Direct Chat. Message ID: ${messageId}`
          : `✅ Poll sent via gateway (directchat). Message ID: ${messageId}`,
        ...pollLine,
      ]);
    }
  },
);

it("reports aggregate failure while preserving every target row", () => {
  const result = broadcastResult([
    ...Array.from({ length: 51 }, (_, index) => ({
      channel: "directchat" as const,
      to: `room-ok-${index}`,
      ok: true as const,
    })),
    {
      channel: "directchat",
      to: "room-suppressed",
      ok: false,
      error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
    },
    {
      channel: "directchat",
      to: "room-partial",
      ok: false,
      error: "second payload failed",
      sentBeforeError: true,
    },
  ]);

  const output = render(result);

  expectText(
    output,
    [
      "Broadcast failed (51/53 succeeded, 2 failed)",
      "room-ok-50",
      "room-suppressed",
      "room-partial",
      "Broadcast send suppressed",
      "second payload failed",
    ],
    ["Broadcast complete"],
  );
});

describe("formatMessageCliText delivery and action terminal safety", () => {
  // Channel APIs author these strings: a hostile or compromised server must not
  // be able to move the operator's cursor, clear the screen, or recolor output.
  const hostile = "\u001b[2J\u001b[31mPWNED";

  it("strips control sequences from a failed send error and its message id", () => {
    const result = sendResult(
      {
        channel: "mattermost",
        to: "channel:testchan",
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "failed",
        error: `Mattermost API 400 Bad Request: ${hostile}`,
        result: { messageId: hostile },
      },
      { channel: "mattermost", to: "channel:testchan" },
    );

    const output = render(result);

    expect(output).not.toContain("\u001b");
    expect(output).toContain("Mattermost API 400 Bad Request: PWNED");
  });

  it("strips control sequences from a broadcast error column", () => {
    const result = broadcastResult(
      [
        {
          channel: "mattermost",
          to: "channel:testchan",
          ok: false,
          error: `Mattermost API 400 Bad Request: ${hostile}`,
        },
      ],
      "mattermost",
    );

    const output = render(result);

    expect(output).not.toContain("\u001b");
    expect(output).toContain("Mattermost API 400 Bad Request: PWNED");
  });

  it("strips control sequences from reaction payload text", () => {
    const added = actionResult("react", { ok: true, added: hostile });
    expect(render(added)).toBe("✅ Reaction added: PWNED");

    const removed = actionResult("react", { ok: true, removed: [hostile, "👍"] });
    const removedOutput = render(removed);
    expect(removedOutput).not.toContain("\u001b");
    expect(removedOutput).toContain("PWNED");
  });

  it.each([{ threadId: hostile, ok: true }, hostile])(
    "strips controls from fallback payload %j",
    (payload) => {
      const result = actionResult("thread-create", payload);

      const output = render(result);

      expect(output).not.toContain("\u001b");
      expect(output).toContain("PWNED");
    },
  );
});
