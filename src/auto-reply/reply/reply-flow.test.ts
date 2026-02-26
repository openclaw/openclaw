import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { MsgContext } from "../templating.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { parseLineDirectives, hasLineDirectives } from "./line-directives.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyToModeFilter, resolveReplyToMode } from "./reply-threading.js";

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
  messageId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    prompt: params.prompt,
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
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
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
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
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
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
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
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
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
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
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
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
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
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
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
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });
});

const emptyCfg = {} as OpenClawConfig;

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
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
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

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    randomSpy.mockRestore();
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

describe("resolveReplyToMode", () => {
  it("resolves defaults, channel overrides, chat-type overrides, and legacy dm overrides", () => {
    const configuredCfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as OpenClawConfig;
    const chatTypeCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as OpenClawConfig;
    const topLevelFallbackCfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const legacyDmCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;

    const cases: Array<{
      cfg: OpenClawConfig;
      channel?: "telegram" | "discord" | "slack";
      chatType?: "direct" | "group" | "channel";
      expected: "off" | "all" | "first";
    }> = [
      { cfg: emptyCfg, channel: "telegram", expected: "off" },
      { cfg: emptyCfg, channel: "discord", expected: "off" },
      { cfg: emptyCfg, channel: "slack", expected: "off" },
      { cfg: emptyCfg, channel: undefined, expected: "all" },
      { cfg: configuredCfg, channel: "telegram", expected: "all" },
      { cfg: configuredCfg, channel: "discord", expected: "first" },
      { cfg: configuredCfg, channel: "slack", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "group", expected: "first" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "channel", expected: "off" },
      { cfg: chatTypeCfg, channel: "slack", chatType: undefined, expected: "off" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "direct", expected: "first" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "channel", expected: "first" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "channel", expected: "off" },
    ];
    for (const testCase of cases) {
      expect(resolveReplyToMode(testCase.cfg, testCase.channel, null, testCase.chatType)).toBe(
        testCase.expected,
      );
    }
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
