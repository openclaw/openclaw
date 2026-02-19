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
  it("converts CRLF to LF", () => {
    expect(normalizeInboundTextNewlines("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts CR to LF", () => {
    expect(normalizeInboundTextNewlines("hello\rworld")).toBe("hello\nworld");
  });

  it("preserves literal backslash-n sequences in Windows paths", () => {
    const windowsPath = "C:\\Work\\nxxx\\README.md";
    expect(normalizeInboundTextNewlines(windowsPath)).toBe("C:\\Work\\nxxx\\README.md");
  });

  it("preserves backslash-n in messages containing Windows paths", () => {
    const message = "Please read the file at C:\\Work\\nxxx\\README.md";
    expect(normalizeInboundTextNewlines(message)).toBe(
      "Please read the file at C:\\Work\\nxxx\\README.md",
    );
  });

  it("preserves multiple backslash-n sequences", () => {
    const message = "C:\\new\\notes\\nested";
    expect(normalizeInboundTextNewlines(message)).toBe("C:\\new\\notes\\nested");
  });

  it("still normalizes actual CRLF while preserving backslash-n", () => {
    const message = "Line 1\r\nC:\\Work\\nxxx";
    expect(normalizeInboundTextNewlines(message)).toBe("Line 1\nC:\\Work\\nxxx");
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
  it("detects quick_replies directive", () => {
    expect(hasLineDirectives("Here are options [[quick_replies: A, B, C]]")).toBe(true);
  });

  it("detects location directive", () => {
    expect(hasLineDirectives("[[location: Place | Address | 35.6 | 139.7]]")).toBe(true);
  });

  it("detects confirm directive", () => {
    expect(hasLineDirectives("[[confirm: Continue? | Yes | No]]")).toBe(true);
  });

  it("detects buttons directive", () => {
    expect(hasLineDirectives("[[buttons: Menu | Choose | Opt1:data1, Opt2:data2]]")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(hasLineDirectives("Just regular text")).toBe(false);
  });

  it("returns false for similar but invalid patterns", () => {
    expect(hasLineDirectives("[[not_a_directive: something]]")).toBe(false);
  });

  it("detects media_player directive", () => {
    expect(hasLineDirectives("[[media_player: Song | Artist | Speaker]]")).toBe(true);
  });

  it("detects event directive", () => {
    expect(hasLineDirectives("[[event: Meeting | Jan 24 | 2pm]]")).toBe(true);
  });

  it("detects agenda directive", () => {
    expect(hasLineDirectives("[[agenda: Today | Meeting:9am, Lunch:12pm]]")).toBe(true);
  });

  it("detects device directive", () => {
    expect(hasLineDirectives("[[device: TV | Room]]")).toBe(true);
  });

  it("detects appletv_remote directive", () => {
    expect(hasLineDirectives("[[appletv_remote: Apple TV | Playing]]")).toBe(true);
  });
});

describe("parseLineDirectives", () => {
  describe("quick_replies", () => {
    it("parses quick_replies and removes from text", () => {
      const result = parseLineDirectives({
        text: "Choose one:\n[[quick_replies: Option A, Option B, Option C]]",
      });

      expect(getLineData(result).quickReplies).toEqual(["Option A", "Option B", "Option C"]);
      expect(result.text).toBe("Choose one:");
    });

    it("handles quick_replies in middle of text", () => {
      const result = parseLineDirectives({
        text: "Before [[quick_replies: A, B]] After",
      });

      expect(getLineData(result).quickReplies).toEqual(["A", "B"]);
      expect(result.text).toBe("Before  After");
    });

    it("merges with existing quickReplies", () => {
      const result = parseLineDirectives({
        text: "Text [[quick_replies: C, D]]",
        channelData: { line: { quickReplies: ["A", "B"] } },
      });

      expect(getLineData(result).quickReplies).toEqual(["A", "B", "C", "D"]);
    });
  });

  describe("location", () => {
    it("parses location with all fields", () => {
      const result = parseLineDirectives({
        text: "Here's the location:\n[[location: Tokyo Station | Tokyo, Japan | 35.6812 | 139.7671]]",
      });

      expect(getLineData(result).location).toEqual({
        title: "Tokyo Station",
        address: "Tokyo, Japan",
        latitude: 35.6812,
        longitude: 139.7671,
      });
      expect(result.text).toBe("Here's the location:");
    });

    it("ignores invalid coordinates", () => {
      const result = parseLineDirectives({
        text: "[[location: Place | Address | invalid | 139.7]]",
      });

      expect(getLineData(result).location).toBeUndefined();
    });

    it("does not override existing location", () => {
      const existing = { title: "Existing", address: "Addr", latitude: 1, longitude: 2 };
      const result = parseLineDirectives({
        text: "[[location: New | New Addr | 35.6 | 139.7]]",
        channelData: { line: { location: existing } },
      });

      expect(getLineData(result).location).toEqual(existing);
    });
  });

  describe("confirm", () => {
    it("parses simple confirm", () => {
      const result = parseLineDirectives({
        text: "[[confirm: Delete this item? | Yes | No]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "confirm",
        text: "Delete this item?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
        altText: "Delete this item?",
      });
      // Text is undefined when directive consumes entire text
      expect(result.text).toBeUndefined();
    });

    it("parses confirm with custom data", () => {
      const result = parseLineDirectives({
        text: "[[confirm: Proceed? | OK:action=confirm | Cancel:action=cancel]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "OK",
        confirmData: "action=confirm",
        cancelLabel: "Cancel",
        cancelData: "action=cancel",
        altText: "Proceed?",
      });
    });
  });

  describe("buttons", () => {
    it("parses buttons with message actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Menu | Select an option | Help:/help, Status:/status]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "buttons",
        title: "Menu",
        text: "Select an option",
        actions: [
          { type: "message", label: "Help", data: "/help" },
          { type: "message", label: "Status", data: "/status" },
        ],
        altText: "Menu: Select an option",
      });
    });

    it("parses buttons with uri actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Links | Visit us | Site:https://example.com]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.[0]).toEqual({
          type: "uri",
          label: "Site",
          uri: "https://example.com",
        });
      }
    });

    it("parses buttons with postback actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Actions | Choose | Select:action=select&id=1]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.[0]).toEqual({
          type: "postback",
          label: "Select",
          data: "action=select&id=1",
        });
      }
    });

    it("limits to 4 actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Menu | Text | A:a, B:b, C:c, D:d, E:e, F:f]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.length).toBe(4);
      }
    });
  });

  describe("media_player", () => {
    it("parses media_player with all fields", () => {
      const result = parseLineDirectives({
        text: "Now playing:\n[[media_player: Bohemian Rhapsody | Queen | Speaker | https://example.com/album.jpg | playing]]",
      });

      const flexMessage = getLineData(result).flexMessage as {
        altText?: string;
        contents?: { footer?: { contents?: unknown[] } };
      };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("🎵 Bohemian Rhapsody - Queen");
      const contents = flexMessage?.contents as { footer?: { contents?: unknown[] } };
      expect(contents.footer?.contents?.length).toBeGreaterThan(0);
      expect(result.text).toBe("Now playing:");
    });

    it("parses media_player with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[media_player: Unknown Track]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("🎵 Unknown Track");
    });

    it("handles paused status", () => {
      const result = parseLineDirectives({
        text: "[[media_player: Song | Artist | Player | | paused]]",
      });

      const flexMessage = getLineData(result).flexMessage as {
        contents?: { body: { contents: unknown[] } };
      };
      expect(flexMessage).toBeDefined();
      const contents = flexMessage?.contents as { body: { contents: unknown[] } };
      expect(contents).toBeDefined();
    });
  });

  describe("event", () => {
    it("parses event with all fields", () => {
      const result = parseLineDirectives({
        text: "[[event: Team Meeting | January 24, 2026 | 2:00 PM - 3:00 PM | Conference Room A | Discuss Q1 roadmap]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📅 Team Meeting - January 24, 2026 2:00 PM - 3:00 PM");
    });

    it("parses event with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[event: Birthday Party | March 15]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📅 Birthday Party - March 15");
    });
  });

  describe("agenda", () => {
    it("parses agenda with multiple events", () => {
      const result = parseLineDirectives({
        text: "[[agenda: Today's Schedule | Team Meeting:9:00 AM, Lunch:12:00 PM, Review:3:00 PM]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📋 Today's Schedule (3 events)");
    });

    it("parses agenda with events without times", () => {
      const result = parseLineDirectives({
        text: "[[agenda: Tasks | Buy groceries, Call mom, Workout]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📋 Tasks (3 events)");
    });
  });

  describe("device", () => {
    it("parses device with controls", () => {
      const result = parseLineDirectives({
        text: "[[device: TV | Streaming Box | Playing | Play/Pause:toggle, Menu:menu]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📱 TV: Playing");
    });

    it("parses device with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[device: Speaker]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📱 Speaker");
    });
  });

  describe("appletv_remote", () => {
    it("parses appletv_remote with status", () => {
      const result = parseLineDirectives({
        text: "[[appletv_remote: Apple TV | Playing]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toContain("Apple TV");
    });

    it("parses appletv_remote with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[appletv_remote: Apple TV]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
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
});

const emptyCfg = {} as OpenClawConfig;

describe("createReplyDispatcher", () => {
  it("drops empty payloads and silent tokens without media", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
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
    expect(deliver.mock.calls[2][0].text).toBe("");
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
  it("defaults to off for Telegram", () => {
    expect(resolveReplyToMode(emptyCfg, "telegram")).toBe("off");
  });

  it("defaults to off for Discord and Slack", () => {
    expect(resolveReplyToMode(emptyCfg, "discord")).toBe("off");
    expect(resolveReplyToMode(emptyCfg, "slack")).toBe("off");
  });

  it("defaults to all when channel is unknown", () => {
    expect(resolveReplyToMode(emptyCfg, undefined)).toBe("all");
  });

  it("uses configured value when present", () => {
    const cfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as OpenClawConfig;
    expect(resolveReplyToMode(cfg, "telegram")).toBe("all");
    expect(resolveReplyToMode(cfg, "discord")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack")).toBe("all");
  });

  it("uses chat-type replyToMode overrides for Slack when configured", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as OpenClawConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "slack", null, "group")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("off");
    expect(resolveReplyToMode(cfg, "slack", null, undefined)).toBe("off");
  });

  it("falls back to top-level replyToMode when no chat-type override is set", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("first");
  });

  it("uses legacy dm.replyToMode for direct messages when no chat-type override exists", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("off");
  });
});

describe("createReplyToModeFilter", () => {
  it("drops replyToId when mode is off", () => {
    const filter = createReplyToModeFilter("off");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBeUndefined();
  });

  it("keeps replyToId when mode is off and reply tags are allowed", () => {
    const filter = createReplyToModeFilter("off", { allowExplicitReplyTagsWhenOff: true });
    expect(filter({ text: "hi", replyToId: "1", replyToTag: true }).replyToId).toBe("1");
  });

  it("keeps replyToId when mode is all", () => {
    const filter = createReplyToModeFilter("all");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
  });

  it("keeps only the first replyToId when mode is first", () => {
    const filter = createReplyToModeFilter("first");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
    expect(filter({ text: "next", replyToId: "1" }).replyToId).toBeUndefined();
  });
});
