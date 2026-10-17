import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import {
  extractContentFromMessage,
  extractTextFromMessage,
  formatTuiFooter,
  formatTuiErrorMessage,
  isolateRtlRenderedLine,
  isTerminalSafeAutocompleteValue,
  isCommandMarkedMessage,
  resolveFinalAssistantText,
  sanitizeTerminalControlsAndBinary,
  sanitizeRenderableLine,
  sanitizeRenderableText,
} from "./tui-formatters.js";

const attachment = (kind: string, url: string, label: string) => ({
  type: "attachment",
  attachment: { kind, url, label },
});
const assistantText = (content: unknown, fields: Record<string, unknown> = {}) =>
  extractTextFromMessage({ role: "assistant", content, ...fields });
const userText = (content: unknown, fields: Record<string, unknown> = {}) =>
  extractTextFromMessage({ role: "user", content, ...fields });
const footer = (
  sessionInfo: Parameters<typeof formatTuiFooter>[0]["sessionInfo"],
  fields: Partial<Parameters<typeof formatTuiFooter>[0]> = {},
) =>
  formatTuiFooter({
    agentLabel: "Main",
    sessionLabel: "main",
    deliver: false,
    sessionInfo,
    ...fields,
  });
const metadata = (label: string, json: string) =>
  `${markInboundContextLabel(label)}\n\`\`\`json\n${json}\n\`\`\`\n\n`;

it("hides complete HTML error pages after an HTTP reason phrase", () => {
  const rendered = resolveFinalAssistantText({
    errorMessage: "HTTP 502 Bad Gateway\n\n<!doctype html><html><body>down</body></html>",
  });
  expect(rendered).toBe(
    "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
  );
  expect(rendered).not.toContain("<html>");
});

describe("formatTuiFooter", () => {
  it.each(["auto", "ultrafast"] as const)(
    "shows %s and session modes in one compact summary",
    (fastMode) => {
      expect(
        footer(
          {
            model: "gpt-5.6-luna@openai:setup-64cddea3-938c-431e-be3b-aa47090577c7",
            fastMode,
            verboseLevel: "full",
            traceLevel: "raw",
            reasoningLevel: "stream",
            totalTokens: 1_200,
            contextTokens: 128_000,
          },
          {
            sessionLabel: "work",
            thinkingLevel: "high",
            deliver: true,
          },
        ),
      ).toBe(
        `agent Main | session work | gpt-5.6-luna high | fast:${fastMode} | verbose full | trace:raw | reasoning:stream | deliver:on | tokens 1.2k/128k (1%)`,
      );
    },
  );

  it("keeps disabled session modes hidden while reporting disabled delivery", () => {
    expect(footer({ model: "fixture-model" })).toBe(
      "agent Main | session main | fixture-model | deliver:off | tokens ?",
    );
  });

  it("sanitizes terminal controls and collapses footer fields to one line", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;footer-title\u0007",
      "\u001b]52;c;footer-clipboard\u0007",
      "\u009b2K",
      "\u009d0;footer-c1-title\u009c",
    ];
    const rendered = footer(
      {
        model: `provider/model-start${attacks[1]}middle${attacks[3]}${attacks[4]}${attacks[5]}model-end\tUnicode`,
      },
      {
        agentLabel: `agent-start${attacks[0]}agent-end\nمرحبا`,
        sessionLabel: `session-start${attacks[2]}session-end\r\nשלום`,
        deliver: true,
      },
    );

    expect(rendered).toContain("agent-startagent-end");
    expect(rendered).toContain("مرحبا");
    expect(rendered).toContain("session-startsession-end");
    expect(rendered).toContain("שלום");
    expect(rendered).toContain("model-startmiddlemodel-end Unicode");
    expect(rendered).toContain("\u2067");
    expect(rendered).toContain("\u2069");
    expect(rendered).not.toMatch(/[\r\n\t]/u);
    for (const attack of attacks) {
      expect(rendered).not.toContain(attack);
    }
  });

  it.each([
    ["active", 12_000, 30_000, "Pursuing goal (12k/30k)"],
    ["blocked", 0, undefined, "Goal blocked (/goal resume)"],
  ] as const)("renders %s goals", (status, tokensUsed, tokenBudget, expected) => {
    expect(
      footer({
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "land PR",
          status,
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed,
          tokenBudget,
          continuationTurns: 0,
        },
      }),
    ).toContain(expected);
  });
});

describe("extractTextFromMessage", () => {
  it.each([
    [[attachment("document", "/document", "Attached file")], "Attached file"],
    [
      [
        { type: "image", source: { type: "url", url: "/image.png" } },
        attachment("document", "/report.pdf", "report.pdf"),
      ],
      "Attached image\nAttached file: report.pdf",
    ],
  ] as const)("renders attachment-only user content %j", (content, expected) => {
    expect(userText(content)).toBe(expected);
  });

  it.each([
    [[{ path: "/media/inbound/media-only.png" }], "Attached image"],
    [
      [
        { path: "/media/inbound/generated-image.png", contentType: "image/png" },
        { path: "/media/inbound/generated-report.pdf", contentType: "application/pdf" },
      ],
      "Attached image\nAttached file",
    ],
  ] as const)("renders canonical media %j for an empty user turn", (media, expected) => {
    expect(userText("", { __openclaw: { media } })).toBe(expected);
  });

  it("sanitizes the display name of an attachment-only user turn", () => {
    expect(
      userText([attachment("document", "/report.pdf", "\u001b[31mreport.pdf\u001b[0m\u0000")]),
    ).toBe("Attached file: report.pdf");
  });

  it.each([
    [{ type: "image", data: "secret-image" }, "Attached image"],
    [{ type: "audio", source: { type: "base64", data: "secret-audio" } }, "Attached audio"],
    [{ type: "video", url: "file:///Users/operator/private/clip.mp4" }, "Attached video"],
    [{ type: "file", url: "file:///etc/passwd", title: "private.txt" }, "Attached file"],
    [attachment("audio", "file:///private/audio.ogg", "private.ogg"), "Attached audio"],
    [
      { type: "image_url", image_url: { url: "https://secret.test/image?ticket=secret" } },
      "Attached image",
    ],
  ] as const)("renders a terminal-safe assistant summary for %j", (block, expected) => {
    const text = assistantText([block]);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/secret|file:|operator|passwd|private/i);
  });

  it("renders canonical and legacy assistant media without exposing references", () => {
    expect(
      assistantText([], {
        __openclaw: {
          media: [
            { kind: "image", path: "/private/generated.png" },
            { kind: "audio", url: "https://secret.test/voice.ogg?ticket=secret" },
            { kind: "video", fileName: "private.mov" },
            { kind: "document", path: "/etc/passwd" },
          ],
        },
      }),
    ).toBe("Attached image\nAttached audio\nAttached video\nAttached file");
    expect(
      assistantText([], {
        mediaUrl: "file:///private/one.png",
        mediaUrls: ["https://secret.test/two.mp3?ticket=secret"],
      }),
    ).toBe("Attached media\nAttached media");
  });

  it("prefers final_answer text over commentary text for assistant messages", () => {
    const content = ["commentary", "final_answer"].map((phase) => ({
      type: "text",
      text: `text:${phase}`,
      textSignature: JSON.stringify({ v: 1, id: `id:${phase}`, phase }),
    }));
    expect(assistantText(content)).toBe("text:final_answer");
  });

  it.each([
    [
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\\u0027s rate limit. Please try again later."},"request_id":"req_123"}',
      ["HTTP 429", "rate_limit_error", "This request would exceed your account's rate limit."],
    ],
    ["", ["unknown error"]],
  ] as const)("renders an empty assistant error turn: %s", (errorMessage, expected) => {
    const text = assistantText([], { stopReason: "error", errorMessage });

    for (const fragment of expected) {
      expect(text).toContain(fragment);
    }
  });

  it("joins multiple text blocks with single newlines", () => {
    const text = assistantText([
      { type: "text", text: "first\ncontinued" },
      { type: "text", text: "second" },
    ]);

    expect(text).toBe("first\ncontinued\nsecond");
  });

  it.each([
    [undefined, "ponder", "hello", "hello"],
    [false, "ponder", "hello", "hello"],
    [true, "ponder", "hello", "[thinking]\nponder\n\nhello"],
    [true, "ponder", "", "[thinking]\nponder"],
    [true, "", "hello", "hello"],
    [true, "", "", ""],
    [false, "ponder", "", ""],
  ] as const)(
    "renders thinking=%s, thought=%j, content=%j",
    (includeThinking, thought, content, expected) => {
      const text = extractTextFromMessage(
        {
          role: "assistant",
          content: [
            { type: "text", text: ` \n${content}\t ` },
            { type: "thinking", thinking: ` \t${thought}\n ` },
          ],
        },
        { includeThinking },
      );

      expect(text).toBe(expected);
    },
  );

  it.each([
    ["Hello\x1b[31m red\x1b[0m\x00world\nNext line", "Hello redworld\nNext line"],
    [[{ type: "text", text: "������������������������" }], "[binary data omitted]"],
  ] as const)("sanitizes assistant content %j", (content, expected) => {
    expect(assistantText(content)).toBe(expected);
  });

  it.each([
    { message: { role: "user" }, body: "Actual user message" },
    { message: { command: true }, body: "Exec completed: task finished successfully" },
  ])("strips leading inbound metadata for $message (#59871)", ({ message, body }) => {
    const text = extractTextFromMessage({
      ...message,
      content:
        metadata("Conversation info:", '{\n  "message_id": "abc123"\n}') +
        metadata("Sender:", '{\n  "label": "Someone"\n}') +
        body,
    });

    expect(text).toBe(body);
  });

  it("keeps metadata-like blocks for non-user messages", () => {
    const text = assistantText(
      metadata("Conversation info:", '{"message_id":"abc123"}') + "Assistant body",
    );

    expect(text).toContain(markInboundContextLabel("Conversation info:"));
    expect(text).toContain("Assistant body");
  });

  it("strips trailing untrusted context metadata suffix blocks for user messages", () => {
    const text = userText(`Hello world

${markInboundContextLabel("Context:")}
<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>
Source: Channel metadata
---
Channel metadata (guildchat)
Sender labels:
example
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>`);

    expect(text).toBe("Hello world");
  });
});

it("renders error text when stopReason is error and content is not an array", () => {
  const text = extractContentFromMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: '429 {"error":{"message":"rate limit"}}',
  });

  expect(text).toContain("HTTP 429");
});

it("detects command-marked messages", () => {
  expect(isCommandMarkedMessage({ command: true })).toBe(true);
  expect(isCommandMarkedMessage({ command: false })).toBe(false);
  expect(isCommandMarkedMessage({})).toBe(false);
});

it("redacts and sanitizes terminal escapes in nested error causes", () => {
  const secret = "sk-abcdefghijklmnopqrstuv";
  const cause = new Error(`\u001b[31mAuthorization: Bearer ${secret}\u001b[0m`);

  const formatted = formatTuiErrorMessage(new Error("gateway down", { cause }));

  expect(formatted).toContain("gateway down");
  expect(formatted).toContain("Authorization: Bearer");
  expect(formatted).not.toContain(secret);
  expect(formatted).not.toContain("\u001b");
});

const cjk =
  "MotherTeresa特蕾莎修女是一个极端投入极有宗教信念愿意亲身服务底层苦难者的人但她不是现代公共卫生意义上的慈善改革者";
const code =
  "Run this:\n```bash\nsudo cp -a /var/lib/machines/fc41/etc/systemd/network/. \\\n           /var/lib/machines/fc43/etc/systemd/network/\n```\nDone.";
it.each([
  ["C1 CSI and OSC", "before\u009b@middle\u009d0;title\u009cafter", "beforemiddleafter"],
  ["long tokens", "a".repeat(140), "a".repeat(140)],
  ["CJK prose", cjk, cjk],
  ["mixed direction lines", "hello\nمرحبا", "hello\n\u2067مرحبا\u2069"],
  ["existing isolation", "\u2067مرحبا\u2069", "\u2067مرحبا\u2069"],
  ["bidi overrides", "\u202eمرحبا\u202c", "\u2067مرحبا\u2069"],
  ["bidi marks", "\u061cمرحبا\u200f", "\u2067مرحبا\u2069"],
  [
    "inline code (#48432)",
    "- `requireConfirmationForMutatingActions: false`",
    "- `requireConfirmationForMutatingActions: false`",
  ],
  ["fenced code", code, code],
])("sanitizes %s without changing safe text", (_name, input, expected) => {
  expect(sanitizeRenderableText(input)).toBe(expected);
});

describe("Markdown display safety", () => {
  it("preserves layout controls while removing neighboring C0, DEL, and C1 controls", () => {
    const input = "a\u0008\tb\u000b\nc\u000c\rd\u000e\u001f\u007f\u0080\u009f";
    expect(sanitizeTerminalControlsAndBinary(input)).toBe("a\tb\nc\rd");
  });

  it("strips hostile controls from source without adding directional isolates", () => {
    const input = "\u202e# مرحبا\u202c\n\u009b31m> שלום\u009b0m";
    const sanitized = sanitizeTerminalControlsAndBinary(input);

    expect(sanitized).toBe("# مرحبا\n> שלום");
    expect(sanitized).not.toMatch(/[\u2066-\u2069]/u);
  });

  it("keeps rendered padding outside RTL isolates", () => {
    const rendered = "  \x1b[1mمرحبا\x1b[0m   ";
    const isolated = isolateRtlRenderedLine(rendered);

    expect(isolated).toBe(`  \u2067\x1b[1mمرحبا\x1b[0m\u2069   `);
    expect(visibleWidth(isolated)).toBe(visibleWidth(rendered));
  });
});

it("accepts ordinary Unicode and rejects terminal or bidi controls", () => {
  expect(isTerminalSafeAutocompleteValue("/tmp/مرحبا-東京.txt")).toBe(true);
  expect(isTerminalSafeAutocompleteValue("👩🏽‍💻/cafe\u0301.txt")).toBe(true);
  for (const value of [
    "bad\x1b[31m",
    "bad\tvalue",
    "bad\rvalue",
    "bad\nvalue",
    "bad\u007fvalue",
    "bad\u0085value",
    "bad\u009bvalue",
    "bad\u200evalue",
    "bad\u202evalue",
    "bad\u2066value",
    "bad\u2069value",
  ]) {
    expect(isTerminalSafeAutocompleteValue(value)).toBe(false);
  }
});

it.each([
  ["left\r\nمرحبا\tשלום right", "\u2067left مرحبا שלום right\u2069"],
  [`safe\x1b]52;c;Y2xpcGJvYXJk\x07\r\n${"�".repeat(20)}\tمرحبا`, "safe [binary data omitted]"],
])("sanitizes and collapses %j", (input, expected) => {
  expect(sanitizeRenderableLine(input)).toBe(expected);
});
