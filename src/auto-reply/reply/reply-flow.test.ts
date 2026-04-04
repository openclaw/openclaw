import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../channels/plugins/contracts/suites.js";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { MsgContext } from "../templating.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { parseLineDirectives, hasLineDirectives } from "./line-directives.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
  scheduleFollowupDrain,
} from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyToModeFilter } from "./reply-threading.js";
import { parseSlackDirectives, hasSlackDirectives } from "./slack-directives.js";

describe("normalizeInboundTextNewlines", () => {
  it("normalizes real newlines and preserves literal backslash-n sequences", () => {
    const cases = [
      { input: "hello\r\nworld", expected: "hello\nworld" },
      { input: "hello\rworld", expected: "hello\nworld" },
      { input: "C:\\Work\\nxxx\\README.md", expected: "C:\\Work\\nxxx\\README.md" },
      {
        input: "Please read the file at C:\\Work\\nxxx\\README.md",
        expected: "Please read the file at C:\\Work\\nxxx\\README.md",
      },
      { input: "C:\\new\\notes\\nested", expected: "C:\\new\\notes\\nested" },
      { input: "Line 1\r\nC:\\Work\\nxxx", expected: "Line 1\nC:\\Work\\nxxx" },
    ] as const;

    for (const testCase of cases) {
      expect(normalizeInboundTextNewlines(testCase.input)).toBe(testCase.expected);
    }
  });
});

describe("inbound context contract (providers + extensions)", () => {
  const cases: Array<{ name: string; ctx: MsgContext }> = [
    {
      name: "whatsapp group",
      ctx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
        ChatType: "group",
        From: "123@g.us",
        To: "+15550001111",
        Body: "[WhatsApp 123@g.us] hi",
        RawBody: "hi",
        CommandBody: "hi",
        SenderName: "Alice",
      },
    },
    {
      name: "telegram group",
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "group:123",
        To: "telegram:123",
        Body: "[Telegram group:123] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Telegram Group",
        SenderName: "Alice",
      },
    },
    {
      name: "slack channel",
      ctx: {
        Provider: "slack",
        Surface: "slack",
        ChatType: "channel",
        From: "slack:channel:C123",
        To: "channel:C123",
        Body: "[Slack #general] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "discord channel",
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "channel",
        From: "group:123",
        To: "channel:123",
        Body: "[Discord #general] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "signal dm",
      ctx: {
        Provider: "signal",
        Surface: "signal",
        ChatType: "direct",
        From: "signal:+15550001111",
        To: "signal:+15550002222",
        Body: "[Signal] hi",
        RawBody: "hi",
        CommandBody: "hi",
      },
    },
    {
      name: "imessage group",
      ctx: {
        Provider: "imessage",
        Surface: "imessage",
        ChatType: "group",
        From: "group:chat_id:123",
        To: "chat_id:123",
        Body: "[iMessage Group] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "iMessage Group",
        SenderName: "Alice",
      },
    },
    {
      name: "matrix channel",
      ctx: {
        Provider: "matrix",
        Surface: "matrix",
        ChatType: "channel",
        From: "matrix:channel:!room:example.org",
        To: "room:!room:example.org",
        Body: "[Matrix] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "msteams channel",
      ctx: {
        Provider: "msteams",
        Surface: "msteams",
        ChatType: "channel",
        From: "msteams:channel:19:abc@thread.tacv2",
        To: "msteams:channel:19:abc@thread.tacv2",
        Body: "[Teams] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Teams Channel",
        SenderName: "Alice",
      },
    },
    {
      name: "zalo dm",
      ctx: {
        Provider: "zalo",
        Surface: "zalo",
        ChatType: "direct",
        From: "zalo:123",
        To: "zalo:123",
        Body: "[Zalo] hi",
        RawBody: "hi",
        CommandBody: "hi",
      },
    },
    {
      name: "zalouser group",
      ctx: {
        Provider: "zalouser",
        Surface: "zalouser",
        ChatType: "group",
        From: "group:123",
        To: "zalouser:123",
        Body: "[Zalo Personal] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Zalouser Group",
        SenderName: "Alice",
      },
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const ctx = finalizeInboundContext({ ...entry.ctx });
      expectInboundContextContract(ctx);
    });
  }
});

const getLineData = (result: ReturnType<typeof parseLineDirectives>) =>
  (result.channelData?.line as Record<string, unknown> | undefined) ?? {};
const getSlackInteractive = (result: ReturnType<typeof parseSlackDirectives>) =>
  result.interactive?.blocks ?? [];

describe("hasLineDirectives", () => {
  it("matches expected detection across directive patterns", () => {
    const cases: Array<{ text: string; expected: boolean }> = [
      { text: "Here are options [[quick_replies: A, B, C]]", expected: true },
      { text: "[[location: Place | Address | 35.6 | 139.7]]", expected: true },
      { text: "[[confirm: Continue? | Yes | No]]", expected: true },
      { text: "[[buttons: Menu | Choose | Opt1:data1, Opt2:data2]]", expected: true },
      { text: "Just regular text", expected: false },
      { text: "[[not_a_directive: something]]", expected: false },
      { text: "[[media_player: Song | Artist | Speaker]]", expected: true },
      { text: "[[event: Meeting | Jan 24 | 2pm]]", expected: true },
      { text: "[[agenda: Today | Meeting:9am, Lunch:12pm]]", expected: true },
      { text: "[[device: TV | Room]]", expected: true },
      { text: "[[appletv_remote: Apple TV | Playing]]", expected: true },
    ];

    for (const testCase of cases) {
      expect(hasLineDirectives(testCase.text)).toBe(testCase.expected);
    }
  });
});

describe("hasSlackDirectives", () => {
  it("matches expected detection across Slack directive patterns", () => {
    const cases: Array<{ text: string; expected: boolean }> = [
      { text: "Pick one [[slack_buttons: Approve:approve, Reject:reject]]", expected: true },
      {
        text: "[[slack_select: Choose a project | Alpha:alpha, Beta:beta]]",
        expected: true,
      },
      { text: "Just regular text", expected: false },
      { text: "[[buttons: Menu | Choose | A:a]]", expected: false },
    ];

    for (const testCase of cases) {
      expect(hasSlackDirectives(testCase.text)).toBe(testCase.expected);
    }
  });
});

describe("parseLineDirectives", () => {
  describe("quick_replies", () => {
    it("parses quick replies variants", () => {
      const cases: Array<{
        text: string;
        channelData?: { line: { quickReplies: string[] } };
        quickReplies: string[];
        outputText?: string;
      }> = [
        {
          text: "Choose one:\n[[quick_replies: Option A, Option B, Option C]]",
          quickReplies: ["Option A", "Option B", "Option C"],
          outputText: "Choose one:",
        },
        {
          text: "Before [[quick_replies: A, B]] After",
          quickReplies: ["A", "B"],
          outputText: "Before  After",
        },
        {
          text: "Text [[quick_replies: C, D]]",
          channelData: { line: { quickReplies: ["A", "B"] } },
          quickReplies: ["A", "B", "C", "D"],
          outputText: "Text",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({
          text: testCase.text,
          channelData: testCase.channelData,
        });
        expect(getLineData(result).quickReplies).toEqual(testCase.quickReplies);
        if (testCase.outputText !== undefined) {
          expect(result.text).toBe(testCase.outputText);
        }
      }
    });
  });

  describe("location", () => {
    it("parses location variants", () => {
      const existing = { title: "Existing", address: "Addr", latitude: 1, longitude: 2 };
      const cases: Array<{
        text: string;
        channelData?: { line: { location: typeof existing } };
        location?: typeof existing;
        outputText?: string;
      }> = [
        {
          text: "Here's the location:\n[[location: Tokyo Station | Tokyo, Japan | 35.6812 | 139.7671]]",
          location: {
            title: "Tokyo Station",
            address: "Tokyo, Japan",
            latitude: 35.6812,
            longitude: 139.7671,
          },
          outputText: "Here's the location:",
        },
        {
          text: "[[location: Place | Address | invalid | 139.7]]",
          location: undefined,
        },
        {
          text: "[[location: New | New Addr | 35.6 | 139.7]]",
          channelData: { line: { location: existing } },
          location: existing,
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({
          text: testCase.text,
          channelData: testCase.channelData,
        });
        expect(getLineData(result).location).toEqual(testCase.location);
        if (testCase.outputText !== undefined) {
          expect(result.text).toBe(testCase.outputText);
        }
      }
    });
  });

  describe("confirm", () => {
    it("parses confirm directives with default and custom action payloads", () => {
      const cases = [
        {
          name: "default yes/no data",
          text: "[[confirm: Delete this item? | Yes | No]]",
          expectedTemplate: {
            type: "confirm",
            text: "Delete this item?",
            confirmLabel: "Yes",
            confirmData: "yes",
            cancelLabel: "No",
            cancelData: "no",
            altText: "Delete this item?",
          },
          expectedText: undefined,
        },
        {
          name: "custom action data",
          text: "[[confirm: Proceed? | OK:action=confirm | Cancel:action=cancel]]",
          expectedTemplate: {
            type: "confirm",
            text: "Proceed?",
            confirmLabel: "OK",
            confirmData: "action=confirm",
            cancelLabel: "Cancel",
            cancelData: "action=cancel",
            altText: "Proceed?",
          },
          expectedText: undefined,
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        expect(getLineData(result).templateMessage, testCase.name).toEqual(
          testCase.expectedTemplate,
        );
        expect(result.text, testCase.name).toBe(testCase.expectedText);
      }
    });
  });

  describe("buttons", () => {
    it("parses message/uri/postback button actions and enforces action caps", () => {
      const cases = [
        {
          name: "message actions",
          text: "[[buttons: Menu | Select an option | Help:/help, Status:/status]]",
          expectedTemplate: {
            type: "buttons",
            title: "Menu",
            text: "Select an option",
            actions: [
              { type: "message", label: "Help", data: "/help" },
              { type: "message", label: "Status", data: "/status" },
            ],
            altText: "Menu: Select an option",
          },
        },
        {
          name: "uri action",
          text: "[[buttons: Links | Visit us | Site:https://example.com]]",
          expectedFirstAction: {
            type: "uri",
            label: "Site",
            uri: "https://example.com",
          },
        },
        {
          name: "postback action",
          text: "[[buttons: Actions | Choose | Select:action=select&id=1]]",
          expectedFirstAction: {
            type: "postback",
            label: "Select",
            data: "action=select&id=1",
          },
        },
        {
          name: "action cap",
          text: "[[buttons: Menu | Text | A:a, B:b, C:c, D:d, E:e, F:f]]",
          expectedActionCount: 4,
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const templateMessage = getLineData(result).templateMessage as {
          type?: string;
          actions?: Array<Record<string, unknown>>;
        };
        expect(templateMessage?.type, testCase.name).toBe("buttons");
        if ("expectedTemplate" in testCase) {
          expect(templateMessage, testCase.name).toEqual(testCase.expectedTemplate);
        }
        if ("expectedFirstAction" in testCase) {
          expect(templateMessage?.actions?.[0], testCase.name).toEqual(
            testCase.expectedFirstAction,
          );
        }
        if ("expectedActionCount" in testCase) {
          expect(templateMessage?.actions?.length, testCase.name).toBe(
            testCase.expectedActionCount,
          );
        }
      }
    });
  });

  describe("media_player", () => {
    it("parses media_player directives across full/minimal/paused variants", () => {
      const cases = [
        {
          name: "all fields",
          text: "Now playing:\n[[media_player: Bohemian Rhapsody | Queen | Speaker | https://example.com/album.jpg | playing]]",
          expectedAltText: "🎵 Bohemian Rhapsody - Queen",
          expectedText: "Now playing:",
          expectFooter: true,
          expectBodyContents: false,
        },
        {
          name: "minimal",
          text: "[[media_player: Unknown Track]]",
          expectedAltText: "🎵 Unknown Track",
          expectedText: undefined,
          expectFooter: false,
          expectBodyContents: false,
        },
        {
          name: "paused status",
          text: "[[media_player: Song | Artist | Player | | paused]]",
          expectedAltText: undefined,
          expectedText: undefined,
          expectFooter: false,
          expectBodyContents: true,
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as {
          altText?: string;
          contents?: { footer?: { contents?: unknown[] }; body?: { contents?: unknown[] } };
        };
        expect(flexMessage, testCase.name).toBeDefined();
        if (testCase.expectedAltText !== undefined) {
          expect(flexMessage?.altText, testCase.name).toBe(testCase.expectedAltText);
        }
        if (testCase.expectedText !== undefined) {
          expect(result.text, testCase.name).toBe(testCase.expectedText);
        }
        if (testCase.expectFooter) {
          expect(flexMessage?.contents?.footer?.contents?.length, testCase.name).toBeGreaterThan(0);
        }
        if ("expectBodyContents" in testCase && testCase.expectBodyContents) {
          expect(flexMessage?.contents?.body?.contents, testCase.name).toBeDefined();
        }
      }
    });
  });

  describe("event", () => {
    it("parses event variants", () => {
      const cases = [
        {
          text: "[[event: Team Meeting | January 24, 2026 | 2:00 PM - 3:00 PM | Conference Room A | Discuss Q1 roadmap]]",
          altText: "📅 Team Meeting - January 24, 2026 2:00 PM - 3:00 PM",
        },
        {
          text: "[[event: Birthday Party | March 15]]",
          altText: "📅 Birthday Party - March 15",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("agenda", () => {
    it("parses agenda variants", () => {
      const cases = [
        {
          text: "[[agenda: Today's Schedule | Team Meeting:9:00 AM, Lunch:12:00 PM, Review:3:00 PM]]",
          altText: "📋 Today's Schedule (3 events)",
        },
        {
          text: "[[agenda: Tasks | Buy groceries, Call mom, Workout]]",
          altText: "📋 Tasks (3 events)",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("device", () => {
    it("parses device variants", () => {
      const cases = [
        {
          text: "[[device: TV | Streaming Box | Playing | Play/Pause:toggle, Menu:menu]]",
          altText: "📱 TV: Playing",
        },
        {
          text: "[[device: Speaker]]",
          altText: "📱 Speaker",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("appletv_remote", () => {
    it("parses appletv remote variants", () => {
      const cases = [
        {
          text: "[[appletv_remote: Apple TV | Playing]]",
          contains: "Apple TV",
        },
        {
          text: "[[appletv_remote: Apple TV]]",
          contains: undefined,
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        if (testCase.contains) {
          expect(flexMessage?.altText).toContain(testCase.contains);
        }
      }
    });
  });

  describe("combined directives", () => {
    it("handles text with no directives", () => {
      const result = parseLineDirectives({
        text: "Just plain text here",
      });

      expect(result.text).toBe("Just plain text here");
      expect(getLineData(result).quickReplies).toBeUndefined();
      expect(getLineData(result).location).toBeUndefined();
      expect(getLineData(result).templateMessage).toBeUndefined();
    });

    it("preserves other payload fields", () => {
      const result = parseLineDirectives({
        text: "Hello [[quick_replies: A, B]]",
        mediaUrl: "https://example.com/image.jpg",
        replyToId: "msg123",
      });

      expect(result.mediaUrl).toBe("https://example.com/image.jpg");
      expect(result.replyToId).toBe("msg123");
      expect(getLineData(result).quickReplies).toEqual(["A", "B"]);
    });
  });
});

describe("parseSlackDirectives", () => {
  it("builds shared text and button blocks from slack_buttons directives", () => {
    const result = parseSlackDirectives({
      text: "Choose an action [[slack_buttons: Approve:approve, Reject:reject]]",
    });

    expect(result.text).toBe("Choose an action");
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "Choose an action",
      },
      {
        type: "buttons",
        buttons: [
          {
            label: "Approve",
            value: "approve",
          },
          {
            label: "Reject",
            value: "reject",
          },
        ],
      },
    ]);
  });

  it("builds shared select blocks from slack_select directives", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Choose a project | Alpha:alpha, Beta:beta]]",
    });

    expect(result.text).toBeUndefined();
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Choose a project",
        options: [
          { label: "Alpha", value: "alpha" },
          { label: "Beta", value: "beta" },
        ],
      },
    ]);
  });

  it("leaves existing slack blocks in channelData and appends shared interactive blocks", () => {
    const result = parseSlackDirectives({
      text: "Act now [[slack_buttons: Retry:retry]]",
      channelData: {
        slack: {
          blocks: [{ type: "divider" }],
        },
      },
    });

    expect(result.text).toBe("Act now");
    expect(result.channelData).toEqual({
      slack: {
        blocks: [{ type: "divider" }],
      },
    });
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "Act now",
      },
      {
        type: "buttons",
        buttons: [{ label: "Retry", value: "retry" }],
      },
    ]);
  });

  it("preserves authored order for mixed Slack directives", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Pick one | Alpha:alpha]] then [[slack_buttons: Retry:retry]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Pick one",
        options: [{ label: "Alpha", value: "alpha" }],
      },
      {
        type: "text",
        text: "then",
      },
      {
        type: "buttons",
        buttons: [{ label: "Retry", value: "retry" }],
      },
    ]);
  });

  it("preserves long Slack directive values in the shared interactive model", () => {
    const long = "x".repeat(120);
    const result = parseSlackDirectives({
      text: `${"y".repeat(3100)} [[slack_select: ${long} | ${long}:${long}]] [[slack_buttons: ${long}:${long}]]`,
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "y".repeat(3100),
      },
      {
        type: "select",
        placeholder: long,
        options: [{ label: long, value: long }],
      },
      {
        type: "buttons",
        buttons: [{ label: long, value: long }],
      },
    ]);
  });

  it("parses optional Slack button styles without truncating callback values", () => {
    const result = parseSlackDirectives({
      text: "[[slack_buttons: Approve:pluginbind:approval-123:o:primary, Reject:deny:danger, Skip:skip:secondary]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "buttons",
        buttons: [
          {
            label: "Approve",
            value: "pluginbind:approval-123:o",
            style: "primary",
          },
          {
            label: "Reject",
            value: "deny",
            style: "danger",
          },
          {
            label: "Skip",
            value: "skip",
            style: "secondary",
          },
        ],
      },
    ]);
  });

  it("preserves slack_select values that end in style-like suffixes", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Choose one | Queue:queue:danger, Archive:archive:primary]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Choose one",
        options: [
          {
            label: "Queue",
            value: "queue:danger",
          },
          {
            label: "Archive",
            value: "archive:primary",
          },
        ],
      },
    ]);
  });

  it("keeps existing interactive blocks when compiling additional Slack directives", () => {
    const result = parseSlackDirectives({
      text: "Choose [[slack_buttons: Retry:retry]]",
      interactive: {
        blocks: [{ type: "text", text: "Existing" }],
      },
    });

    expect(getSlackInteractive(result)).toEqual([
      { type: "text", text: "Existing" },
      { type: "text", text: "Choose" },
      { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
    ]);
  });

  it("ignores malformed directive choices when none remain", () => {
    const result = parseSlackDirectives({
      text: "Choose [[slack_buttons: : , : ]]",
    });

    expect(result).toEqual({
      text: "Choose [[slack_buttons: : , : ]]",
    });
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let previousRuntimeError: typeof defaultRuntime.error;

beforeAll(() => {
  previousRuntimeError = defaultRuntime.error;
  defaultRuntime.error = (() => {}) as typeof defaultRuntime.error;
});

afterAll(() => {
  defaultRuntime.error = previousRuntimeError;
});

function createRun(params: {
  prompt: string;
  displayText?: string;
  summaryLine?: string;
  messageId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    execution: { visibility: "internal", agentPrompt: params.prompt },
    display:
      params.displayText || params.summaryLine
        ? {
            visibility: "user-visible",
            text: params.displayText,
            summaryLine: params.summaryLine,
          }
        : undefined,
    messageId: params.messageId,
    enqueuedAt: Date.now(),
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    originatingThreadId: params.originatingThreadId,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

describe("followup queue deduplication", () => {
  beforeEach(() => {
    resetRecentQueuedMessageIdDedupe();
  });

  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(first).toBe(true);

    // Second enqueue with same message id should be deduplicated
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(second).toBe(false);

    // Third enqueue with different message id should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    // Should collect both unique messages
    expect(calls[0]?.execution.agentPrompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates same message_id after queue drain restarts", async () => {
    const key = `test-dedup-after-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const redelivery = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first-redelivery",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      settings,
    );

    expect(redelivery).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-dedup-cross-module-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueA.resetRecentQueuedMessageIdDedupe();
    enqueueB.resetRecentQueuedMessageIdDedupe();

    try {
      expect(
        enqueueA.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          settings,
        ),
      ).toBe(true);

      scheduleFollowupDrain(key, runFollowup);
      await done.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(
        enqueueB.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first-redelivery",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          settings,
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      clearSessionQueues([key]);
      enqueueA.resetRecentQueuedMessageIdDedupe();
      enqueueB.resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not collide recent message-id keys when routing contains delimiters", async () => {
    const key = `test-dedup-key-collision-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal|group",
        originatingTo: "peer",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    // Different routing dimensions can produce identical pipe-joined strings.
    // This must not be deduplicated as a replay of the first run.
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "group|peer",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("deduplicates exact prompt when routing matches and no message id", async () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(first).toBe(true);

    // Second enqueue with same prompt should be allowed (default dedupe: message id only)
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(second).toBe(true);

    // Third enqueue with different prompt should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world 2",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(third).toBe(true);
  });

  it("does not deduplicate across different providers without message id", async () => {
    const key = `test-dedup-cross-provider-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("can opt-in to prompt-based dedupe when message id is absent", async () => {
    const key = `test-dedup-prompt-mode-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
      "prompt",
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
      "prompt",
    );
    expect(second).toBe(false);
  });
});

describe("followup queue collect routing", () => {
  it("does not collect when destinations differ", async () => {
    const key = `test-collect-diff-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toBe("one");
    expect(calls[1]?.execution.agentPrompt).toBe("two");
  });

  it("collects when channel+destination match", async () => {
    const key = `test-collect-same-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
  });

  it("collects Slack messages in same thread and preserves string thread id", async () => {
    const key = `test-collect-slack-thread-same-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("does not collect Slack messages when thread ids differ", async () => {
    const key = `test-collect-slack-thread-diff-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000002",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toBe("one");
    expect(calls[1]?.execution.agentPrompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
  });

  it("collect mode renders explicit display payloads instead of internal prompts", async () => {
    const key = `test-collect-display-boundary-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "INTERNAL first prompt",
        displayText: "visible first message",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "INTERNAL second prompt",
        displayText: "visible second message",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.execution.agentPrompt).toContain("visible first message");
    expect(calls[0]?.execution.agentPrompt).toContain("visible second message");
    expect(calls[0]?.execution.agentPrompt).not.toContain("INTERNAL first prompt");
    expect(calls[0]?.execution.agentPrompt).not.toContain("INTERNAL second prompt");
  });

  it("falls back to individual followups when collect items have no display payload", async () => {
    const key = `test-collect-no-display-fallback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "internal one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "internal two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.execution.agentPrompt).toBe("internal one");
    expect(calls[1]?.execution.agentPrompt).toBe("internal two");
  });

  it("preserves non-display runs when collect queues mix display and hidden items", async () => {
    const key = `test-collect-mixed-display-fallback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "internal one", displayText: "visible one" }),
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "internal two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.execution.agentPrompt).toBe("internal one");
    expect(calls[1]?.execution.agentPrompt).toBe("internal two");
  });

  it("preserves collect overflow summaries when falling back to individual drain", async () => {
    const key = `test-collect-summary-fallback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first hidden item" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second hidden item" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.execution.agentPrompt).toContain(
      "[Queue overflow] Dropped 1 message due to cap.",
    );
    expect(calls[0]?.execution.agentPrompt).toContain("- [Hidden message]");
    expect(calls[0]?.execution.agentPrompt).not.toContain("first hidden item");
    expect(calls[1]?.execution.agentPrompt).toBe("second hidden item");
  });

  it("retries collect display batches as a batch after transient execution failures", async () => {
    const key = `test-collect-display-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "hidden one", displayText: "visible one" }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({ prompt: "hidden two", displayText: "visible two" }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.execution.agentPrompt).toContain("visible one");
    expect(calls[0]?.execution.agentPrompt).toContain("visible two");
    expect(calls[0]?.execution.agentPrompt).not.toContain("hidden one");
    expect(calls[0]?.execution.agentPrompt).not.toContain("hidden two");
  });

  it("emits summarize overflow before exiting forced individual collect drain", async () => {
    const key = `test-followup-forced-individual-overflow-summary-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= 2) {
        done.resolve();
      }
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "first hidden item", displayText: "visible first" }),
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "second hidden item", displayText: "visible second" }),
        display: { visibility: "summary-only", text: "hidden without summary" },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const prompts = calls.map(
      (call) => call.display?.text ?? call.display?.summaryLine ?? call.execution.agentPrompt,
    );
    expect(prompts[0]).toContain("[Queue overflow]");
    expect(prompts[0]).toContain("visible first");
    expect(prompts).toHaveLength(2);
    expect(calls[1]?.execution.agentPrompt).toBe("second hidden item");
  });

  it("emits summarize overflow when forced individual collect drain empties queued items", async () => {
    const key = `test-followup-forced-individual-empty-overflow-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= 2) {
        done.resolve();
      }
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "first hidden item",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "second hidden item",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.execution.agentPrompt).toContain("[Queue overflow]");
    expect(calls[0]?.execution.agentPrompt).toContain("[Hidden message]");
    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[1]?.execution.agentPrompt).toBe("second hidden item");
  });

  it("does not retry already-run collect fallback items after a later failure", async () => {
    const key = `test-collect-fallback-progress-${Date.now()}`;
    const calls: FollowupRun[] = [];
    let attempt = 0;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      attempt += 1;
      if (attempt === 2) {
        throw new Error("boom");
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first hidden item" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second hidden item" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls.map((call) => call.execution.agentPrompt)).toEqual([
      "first hidden item",
      "second hidden item",
    ]);

    const done = createDeferred<void>();
    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      done.resolve();
    });
    await done.promise;

    expect(calls.map((call) => call.execution.agentPrompt)).toEqual([
      "first hidden item",
      "second hidden item",
      "second hidden item",
    ]);
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const key = `test-collect-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toContain("Queued #1\none");
    expect(calls[0]?.execution.agentPrompt).toContain("Queued #2\ntwo");
  });

  it("preserves full deferred prompt context when collect mode re-batches display payloads", async () => {
    const key = `test-collect-display-context-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt:
          "[System]\n[Thread history - for context]\nprior note\n\n[User sent media without caption]",
        displayText:
          "[System]\n[Thread history - for context]\nprior note\n\n[User sent media without caption]",
        summaryLine: "latest user body",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "[System]\nsecond queued prompt",
        displayText: "[System]\nsecond queued prompt",
        summaryLine: "second user body",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const batchedPrompt = calls[0]?.execution.agentPrompt ?? "";
    expect(batchedPrompt).toContain("[Thread history - for context]\nprior note");
    expect(batchedPrompt).toContain("[User sent media without caption]");
    expect(batchedPrompt).toContain("[System]\nsecond queued prompt");
    expect(batchedPrompt).not.toContain("Queued #1\nlatest user body");
  });

  it.each([
    {
      name: "display-first mixed collect retries",
      first: createRun({ prompt: "display item", displayText: "visible item" }),
      second: createRun({ prompt: "hidden item" }),
      expected: ["display item", "hidden item", "hidden item"],
    },
    {
      name: "hidden-first mixed collect retries",
      first: createRun({ prompt: "hidden item" }),
      second: createRun({ prompt: "display item", displayText: "visible item" }),
      expected: ["hidden item", "display item", "display item"],
    },
  ])("keeps individual drain semantics for $name", async ({ first, second, expected }) => {
    const key = `test-mixed-collect-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      attempt += 1;
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      if (attempt === 3) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => call.execution.agentPrompt)).toEqual(expected);
    expect(calls[2]?.display).toEqual(second.display);
  });

  it("honors debounce while draining mixed collect fallback items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    try {
      const key = `test-mixed-collect-debounce-${Date.now()}`;
      const calls: Array<{ prompt: string; at: number }> = [];
      let releaseFirst!: () => void;
      const firstCallStarted = createDeferred<void>();
      const firstCallCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const settings: QueueSettings = {
        mode: "collect",
        debounceMs: 5_000,
        cap: 50,
        dropPolicy: "summarize",
      };

      const runFollowup = vi.fn(async (run: FollowupRun) => {
        calls.push({ prompt: run.execution.agentPrompt, at: Date.now() });
        if (calls.length === 1) {
          firstCallStarted.resolve();
          await firstCallCanFinish;
        }
      });

      enqueueFollowupRun(key, createRun({ prompt: "hidden first" }), settings);
      enqueueFollowupRun(
        key,
        createRun({ prompt: "visible second", displayText: "visible second" }),
        settings,
      );

      scheduleFollowupDrain(key, runFollowup);
      await vi.advanceTimersByTimeAsync(5_000);
      await firstCallStarted.promise;
      expect(calls.map((call) => call.prompt)).toEqual(["hidden first"]);

      enqueueFollowupRun(key, createRun({ prompt: "hidden third" }), settings);
      releaseFirst();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls.map((call) => call.prompt)).toEqual(["hidden first"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls[1]?.prompt).toBe("visible second");
      expect(calls[2]?.prompt).toBe("hidden third");
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });

  it("emits collect overflow summary before falling back from an invalid display batch", async () => {
    const key = `test-collect-render-fallback-summary-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "first hidden item", displayText: "visible first" }),
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "second hidden item", displayText: "visible second" }),
        display: { visibility: "summary-only", text: "hidden without summary" },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.execution.agentPrompt).toContain(
      "[Queue overflow] Dropped 1 message due to cap.",
    );
    expect(calls[0]?.execution.agentPrompt).toContain("- visible first");
    expect(calls[1]?.execution.agentPrompt).toBe("first hidden item");
    expect(calls[1]?.display?.text).toBe("visible first");
  });

  it("retries collect overflow summary before forcing individual drain", async () => {
    const key = `test-collect-overflow-summary-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient summary failure");
      }
      calls.push(run);
      if (calls.length >= 2) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "first hidden item", displayText: "visible first" }),
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "second hidden item" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.execution.agentPrompt).toContain(
      "[Queue overflow] Dropped 1 message due to cap.",
    );
    expect(calls[0]?.execution.agentPrompt).toContain("- visible first");
    expect(calls[1]?.execution.agentPrompt).toBe("first hidden item");
    expect(calls[1]?.display?.text).toBe("visible first");
  });

  it("retries overflow summary delivery without losing dropped previews", async () => {
    const key = `test-overflow-summary-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.execution.agentPrompt).toContain(
      "[Queue overflow] Dropped 1 message due to cap.",
    );
    expect(calls[0]?.execution.agentPrompt).toContain("- [Hidden message]");
    expect(calls[0]?.execution.agentPrompt).not.toContain("first");
  });

  it("preserves routing metadata on overflow summary followups", async () => {
    const key = `test-overflow-summary-routing-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[0]?.execution.agentPrompt).toContain(
      "[Queue overflow] Dropped 1 message due to cap.",
    );
    expect(calls[0]?.execution.agentPrompt).toContain("- [Hidden message]");
  });
});

describe("followup queue drain restart after idle window", () => {
  it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
    const key = `test-no-stale-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const drained = createDeferred<void>();

    // Simulate finalizeWithFollowup calling schedule without pending queue items.
    scheduleFollowupDrain(key, async (run) => {
      staleCalls.push(run);
    });

    enqueueFollowupRun(key, createRun({ prompt: "after-empty-schedule" }), settings);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(staleCalls).toHaveLength(0);

    scheduleFollowupDrain(key, async (run) => {
      freshCalls.push(run);
      drained.resolve();
    });
    await drained.promise;

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.execution.agentPrompt).toBe("after-empty-schedule");
  });

  it("processes a message enqueued after the drain empties when enqueue refreshes the callback", async () => {
    const key = `test-idle-window-race-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred<void>();
    const secondProcessed = createDeferred<void>();
    let callCount = 0;
    const runFollowup = async (run: FollowupRun) => {
      callCount++;
      calls.push(run);
      if (callCount === 1) {
        firstProcessed.resolve();
      }
      if (callCount === 2) {
        secondProcessed.resolve();
      }
    };

    // Enqueue first message and start drain.
    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    // Wait for the first message to be processed by the drain.
    await firstProcessed.promise;

    // Yield past the drain's finally block so it can set draining:false and
    // delete the queue key from FOLLOWUP_QUEUES (the idle-window boundary).
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Simulate the race: a new message arrives AFTER the drain finished and
    // deleted the queue. The next enqueue refreshes the callback and should
    // kick a new idle drain automatically.
    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      runFollowup,
    );

    await secondProcessed.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.execution.agentPrompt).toBe("before-idle");
    expect(calls[1]?.execution.agentPrompt).toBe("after-idle");
  });

  it("restarts an idle drain with the newest followup callback", async () => {
    const key = `test-idle-window-fresh-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const firstProcessed = createDeferred<void>();
    const secondProcessed = createDeferred<void>();

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
      if (staleCalls.length === 1) {
        firstProcessed.resolve();
      }
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
      secondProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, staleFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      freshFollowup,
    );
    await secondProcessed.promise;

    expect(staleCalls).toHaveLength(1);
    expect(staleCalls[0]?.execution.agentPrompt).toBe("before-idle");
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.execution.agentPrompt).toBe("after-idle");
  });

  it("does not auto-start a drain when a busy run only refreshes the callback", async () => {
    const key = `test-busy-run-refreshes-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "queued-while-busy" }),
      settings,
      "message-id",
      freshFollowup,
      false,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(freshCalls).toHaveLength(0);

    scheduleFollowupDrain(key, staleFollowup);
    await vi.waitFor(() => {
      expect(freshCalls).toHaveLength(1);
    });

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls[0]?.execution.agentPrompt).toBe("queued-while-busy");
  });

  it("restarts an idle drain across distinct enqueue and drain module instances when enqueue refreshes the callback", async () => {
    const drainA = await importFreshModule<typeof import("./queue/drain.js")>(
      import.meta.url,
      "./queue/drain.js?scope=restart-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=restart-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-idle-window-cross-module-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred<void>();

    enqueueB.resetRecentQueuedMessageIdDedupe();

    try {
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        if (calls.length === 1) {
          firstProcessed.resolve();
        }
      };

      enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
      drainA.scheduleFollowupDrain(key, runFollowup);
      await firstProcessed.promise;

      await new Promise<void>((resolve) => setImmediate(resolve));

      enqueueB.enqueueFollowupRun(
        key,
        createRun({ prompt: "after-idle" }),
        settings,
        "message-id",
        runFollowup,
      );

      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 1_000 },
      );

      expect(calls[0]?.execution.agentPrompt).toBe("before-idle");
      expect(calls[1]?.execution.agentPrompt).toBe("after-idle");
    } finally {
      clearSessionQueues([key]);
      drainA.clearFollowupDrainCallback(key);
      enqueueB.resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not double-drain when a message arrives while drain is still running", async () => {
    const key = `test-no-double-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const allProcessed = createDeferred<void>();
    // runFollowup resolves only after both items are enqueued so the second
    // item is already in the queue when the first drain step finishes.
    let runFollowupResolve!: () => void;
    const runFollowupGate = new Promise<void>((res) => {
      runFollowupResolve = res;
    });
    const runFollowup = async (run: FollowupRun) => {
      await runFollowupGate;
      calls.push(run);
      if (calls.length >= 2) {
        allProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    // Enqueue second message while the drain is mid-flight (draining:true).
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    // Release the gate so both items can drain.
    runFollowupResolve();

    await allProcessed.promise;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.execution.agentPrompt).toBe("first");
    expect(calls[1]?.execution.agentPrompt).toBe("second");
  });

  it("does not process messages after clearSessionQueues clears the callback", async () => {
    const key = `test-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-clear" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;

    // Let drain finish and delete the queue.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Clear queues (simulates session teardown) — should also clear the callback.
    const { clearSessionQueues } = await import("./queue.js");
    clearSessionQueues([key]);

    // Enqueue after clear: should NOT auto-start a drain (callback is gone).
    enqueueFollowupRun(key, createRun({ prompt: "after-clear" }), settings);

    // Yield a few ticks; no drain should fire.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Only the first message was processed; the post-clear one is still pending.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.execution.agentPrompt).toBe("before-clear");
  });

  it("clears the remembered callback after a queue drains fully", async () => {
    const key = `test-auto-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred<void>();

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;

    // Let the idle drain finish and clear its callback.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Enqueueing after a clean drain should not auto-start anything until a
    // fresh finalize path supplies a new callback.
    enqueueFollowupRun(key, createRun({ prompt: "after-idle" }), settings);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.execution.agentPrompt).toBe("before-idle");
  });
});

describe("createReplyDispatcher", () => {
  it("drops empty payloads and exact silent tokens without media", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(true);

    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[0]?.text).toBe(`${SILENT_REPLY_TOKEN} -- nope`);
    expect(deliver.mock.calls[1]?.[0]?.text).toBe(`interject.${SILENT_REPLY_TOKEN}`);
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onHeartbeatStrip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].text).toBe("PFX hello");
    expect(onHeartbeatStrip).toHaveBeenCalledTimes(2);
  });

  it("avoids double-prefixing and keeps media when heartbeat is the only text", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
    });

    expect(
      dispatcher.sendFinalReply({
        text: "PFX already",
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: HEARTBEAT_TOKEN,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: `${SILENT_REPLY_TOKEN} -- explanation`,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);

    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[0][0].text).toBe("PFX already");
    expect(deliver.mock.calls[1][0].text).toBe("");
    expect(deliver.mock.calls[2][0].text).toBe(`PFX ${SILENT_REPLY_TOKEN} -- explanation`);
  });

  it("preserves ordering across tool, block, and final replies", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
      if (info.kind === "tool") {
        await Promise.resolve();
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    dispatcher.sendFinalReply({ text: "final" });

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["tool", "block", "final"]);
  });

  it("fires onIdle when the queue drains", async () => {
    const deliver: Parameters<typeof createReplyDispatcher>[0]["deliver"] = async () =>
      await Promise.resolve();
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, onIdle });

    dispatcher.sendToolResult({ text: "one" });
    dispatcher.sendFinalReply({ text: "two" });

    await dispatcher.waitForIdle();
    dispatcher.markComplete();
    await Promise.resolve();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("delays block replies after the first when humanDelay is natural", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "natural" },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses custom bounds for humanDelay and clamps when max <= min", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "custom", minMs: 1200, maxMs: 400 },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("createReplyToModeFilter", () => {
  it("handles off/all mode behavior for replyToId", () => {
    const cases: Array<{
      filter: ReturnType<typeof createReplyToModeFilter>;
      input: { text: string; replyToId?: string; replyToTag?: boolean };
      expectedReplyToId?: string;
    }> = [
      {
        filter: createReplyToModeFilter("off"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: undefined,
      },
      {
        filter: createReplyToModeFilter("off", { allowExplicitReplyTagsWhenOff: true }),
        input: { text: "hi", replyToId: "1", replyToTag: true },
        expectedReplyToId: "1",
      },
      {
        filter: createReplyToModeFilter("all"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: "1",
      },
    ];
    for (const testCase of cases) {
      expect(testCase.filter(testCase.input).replyToId).toBe(testCase.expectedReplyToId);
    }
  });

  it("keeps only the first replyToId when mode is first", () => {
    const filter = createReplyToModeFilter("first");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
    expect(filter({ text: "next", replyToId: "1" }).replyToId).toBeUndefined();
  });
});
