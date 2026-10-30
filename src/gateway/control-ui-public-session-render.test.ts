import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  PUBLIC_SESSION_CONTENT_SECURITY_POLICY,
  renderPublicSessionDocument,
} from "./control-ui-public-session-render.js";

function message(role: string, content: unknown, fields: Record<string, unknown> = {}) {
  return { role, content, ...fields };
}
function media(role: string, id: string, content: unknown[]) {
  return message(role, content, { __openclaw: { id } });
}
const text = (value: string, phase?: string) => ({
  type: "text",
  text: value,
  ...(phase ? { textSignature: JSON.stringify({ v: 1, phase }) } : {}),
});
const assistant = (content: unknown, fields?: Record<string, unknown>) =>
  message("assistant", content, fields);
const image = (fields: Record<string, unknown> = {}) => ({
  type: "image",
  data: "PRIVATE_BYTES",
  ...fields,
});

function render(
  messages: unknown[] | string,
  overrides: Partial<Parameters<typeof renderPublicSessionDocument>[0]> = {},
) {
  return renderPublicSessionDocument({
    messages: typeof messages === "string" ? [assistant(messages)] : messages,
    title: "A shared conversation",
    truncated: false,
    latestUrl: "/share/session?token=v1.opaque",
    canonicalUrl: "https://example.test/share/session/demo",
    cardUrl: "https://example.test/share/card.png",
    assetBasePath: "/control",
    ...overrides,
  });
}

function fragment(messages: unknown[] | string, overrides: Parameters<typeof render>[1] = {}) {
  return JSDOM.fragment(render(messages, overrides));
}

describe("public session document", () => {
  const widgetDetails = {
    kind: "canvas",
    presentation: {
      target: "assistant_message",
      title: "Saved timeline",
      preferredHeight: 600,
      sandbox: "scripts",
    },
    view: { id: "cv_timeline", url: "/__openclaw__/canvas/documents/cv_timeline/index.html" },
  };
  const widgetReceipt = message("toolResult", [], {
    toolName: "show_widget",
    details: widgetDetails,
  });
  const nestedReceipt = createNestedToolActivity({
    runId: "run",
    scopeId: "scope",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "call",
    toolName: "show_widget",
    input: {},
    result: { content: [], details: widgetDetails },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  });
  const widgetOptions = {
    mediaBaseUrl: "/control/share/session/media?token=v1.opaque",
    widgetUrls: new Map([["cv_timeline", "/control/share/session/media?widget=v1.widget"]]),
  };

  it("renders hosted shortcodes with the public widget URL and preserves surrounding text", () => {
    const page = fragment(
      'Before [embed ref="cv_timeline" title="A & B" height="1050" /] After',
      widgetOptions,
    );
    const article = page.querySelector("article")!;
    const frame = article.querySelector("iframe")!;
    expect(article.textContent).toContain("Before  After");
    expect(article.textContent).not.toContain("[embed");
    expect(frame.getAttribute("src")).toBe("/control/share/session/media?widget=v1.widget");
    expect(frame.src).not.toContain("v1.opaque");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("title")).toBe("A & B");
    expect(frame.style.height).toBe("1050px");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("merges a nested receipt into its same-turn shortcode and inherits its title", () => {
    const page = fragment(
      [
        message("user", "Show the timeline"),
        nestedReceipt,
        message("assistant", 'Here it is [embed ref="cv_timeline" /]'),
      ],
      widgetOptions,
    );
    expect(page.querySelectorAll("iframe")).toHaveLength(1);
    const frame = page.querySelector("iframe")!;
    expect(frame.closest("article")?.textContent).toContain("Here it is");
    expect(frame.title).toBe("Saved timeline");
  });

  it("renders standalone tool receipts at their position and deduplicates across turns", () => {
    const page = fragment(
      [
        widgetReceipt,
        message("assistant", "Done"),
        message("user", "Again"),
        nestedReceipt,
        message(
          "assistant",
          '[embed url="/__openclaw__/canvas/documents/cv_timeline/index.html" /]',
        ),
      ],
      widgetOptions,
    );
    expect(page.querySelectorAll("iframe")).toHaveLength(1);
    const article = page.querySelector("article")!;
    expect(article.classList.contains("assistant")).toBe(true);
    expect(article.querySelector("iframe")?.style.height).toBe("600px");
  });

  it("keeps code literal and excludes non-inline receipts", () => {
    const literal =
      '```text\n[embed ref="cv_timeline" /]\n```\n`[embed url="https://example.test" /]`';
    const page = fragment(
      [
        message("assistant", literal),
        { ...widgetReceipt, isError: true },
        { ...widgetReceipt, display: false },
        { ...widgetReceipt, details: { ...widgetDetails, presentation: { target: "node_panel" } } },
      ],
      widgetOptions,
    );
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.querySelector("article a")).toBeNull();
    expect(page.querySelector("pre")?.textContent).toContain('[embed ref="cv_timeline" /]');
    expect(page.querySelector("p code")?.textContent).toBe('[embed url="https://example.test" /]');
  });

  it("links non-hosted embeds without loading them and omits private Gateway pages", () => {
    const page = fragment(
      [
        message(
          "assistant",
          [
            'Watch [embed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42" title="A & B" /] now.',
            '[embed url="https://example.test/page"]ignored body[/embed]',
            '[embed url="/__openclaw__/canvas/game/index.html" title="Private" /]',
            '[embed url="javascript:alert(1)" /][embed url="https://user:pw@example.test/" /]',
          ].join("\n\n"),
        ),
        message("assistant", '[embed url="/__openclaw__/canvas/" /]'),
      ],
      widgetOptions,
    );
    const articles = page.querySelectorAll("article");
    expect(articles).toHaveLength(1);
    const articleText = articles[0]!.textContent;
    expect(articleText).toContain("Watch  now.");
    expect(articleText).not.toMatch(/\[embed|ignored body|Private/);
    expect(page.querySelector("iframe")).toBeNull();
    expect(
      [...articles[0]!.querySelectorAll("a")].map((link) => [
        link.getAttribute("href"),
        link.getAttribute("rel"),
        link.textContent,
      ]),
    ).toEqual([
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "noreferrer noopener nofollow", "A & B"],
      ["https://example.test/page", "noreferrer noopener nofollow", "https://example.test/page"],
    ]);
  });

  it("renders mixed widget and link embeds in shortcode order", () => {
    const page = fragment(
      '[embed url="https://example.test/first" /] [embed ref="cv_timeline" /] [embed url="https://example.test/last" /]',
      widgetOptions,
    );
    expect(
      [...page.querySelectorAll("article a, article iframe")].map(
        (node) => node.getAttribute("href") ?? node.getAttribute("data-public-widget"),
      ),
    ).toEqual(["https://example.test/first", "cv_timeline", "https://example.test/last"]);
  });

  it("retains shortcode-only messages and requires a mapped widget URL to render frames", () => {
    const messages = [message("assistant", '[embed ref="cv_timeline" /]')];
    expect(fragment(messages, widgetOptions).querySelector("iframe")?.title).toBe(
      "A shared conversation",
    );
    expect(fragment(messages).querySelector("iframe")).toBeNull();
  });
  it("adds only a protected login handoff, including unavailable conversations", () => {
    const entryUrl = "/control/__openclaw__/session-entry?path=%2Fcontrol%2Fchat%2Fmain%2Ftopic";
    const html = render([], { entryUrl });
    expect(html).toContain(`href="${entryUrl}"`);
    expect(html).toContain("Log in");
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="15"></noscript>');
    expect(html).toContain('data-public-refresh="true"');
    expect(html).toContain('redirect:"error"');
    expect(html).not.toMatch(/new WebSocket|bootstrap|sessions.list/);
    const unavailable = render([], {
      entryUrl,
      title: "Conversation unavailable",
      unavailable: true,
    });
    expect(unavailable).toContain("not publicly available");
    const unavailableMain = JSDOM.fragment(unavailable).querySelector("main")!;
    expect(unavailableMain.textContent).not.toContain("Public · Read-only");
    expect(unavailableMain.querySelector(".colophon")).toBeNull();
    expect(unavailable).not.toContain('http-equiv="refresh"');
  });
  it("publishes only user and assistant conversation text without internal input or metadata", () => {
    const token = `sk-${"a".repeat(48)}`;
    const operatorSecret = "internal-ticket-8315";
    applyLoggingConfig({ redactPatterns: [String.raw`/internal-ticket-\d+/g`] });
    onTestFinished(resetLogger);
    const html = render(
      [
        message("system", "private system instructions"),
        message("developer", "private developer instructions"),
        message("user", "hidden user input", { display: false }),
        ...["internal_system", "inter_session", "unknown"].map((kind) =>
          message("user", "private handoff", { provenance: { kind } }),
        ),
        message("user", "[Inter-session message] sourceSession=private\nprivate legacy handoff"),
        message("toolResult", "private tool output"),
        message("assistant", "Public progress", { phase: "commentary" }),
        message("assistant", "<think>private tagged reasoning</think>Public visible answer"),
        message("assistant", "<think>private unfinished reasoning"),
        message(
          "assistant",
          '<tool_call>{"name":"read","arguments":{"text":"private inline tool payload"}}</tool_call>',
        ),
        message(
          "assistant",
          ']<]minimax[>[<tool_call>]<]minimax[>[<invoke name="read">private encoded tool payload</invoke>]<]minimax[>[</tool_call>',
        ),
        message("assistant", "NO_REPLY"),
        message("assistant", "HEARTBEAT_OK"),
        message("assistant", "no_r"),
        message("assistant", "NO_R", { display: true }),
        message("user", "[OpenClaw heartbeat poll]"),
        message(
          "user",
          [
            { type: "input_text", text: "First public question" },
            { type: "image", data: "private image bytes" },
            { type: "text", text: "Second public question" },
          ],
          {
            provenance: { kind: "external_user" },
            __openclaw: { senderIdentity: "private sender identity" },
          },
        ),
        assistant([
          { type: "reasoning", text: "private" },
          { type: "toolCall", text: "private", arguments: { secret: "private" } },
          text("Public phased commentary", "commentary"),
          text("**Public final answer**", "final_answer"),
          { type: "canvas", text: "private widget" },
        ]),
        message(
          "user",
          `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nVisible user request ${token}`,
        ),
        assistant(`Visible response ${token} ${operatorSecret}`),
      ],
      { title: `Shared ${token} ${operatorSecret}` },
    );
    expect(html).toContain("First public question");
    expect(html).toContain("Public visible answer");
    expect(html).toContain("Public progress");
    expect(html).toContain("Public phased commentary");
    expect(html).toContain("Second public question");
    expect(html).toContain("<strong>Public final answer</strong>");
    expect(html).toContain("<p>no_r</p>");
    expect(html).toContain("<p>NO_R</p>");
    expect(html).not.toMatch(
      /private|Private|OPENCLAW_INTERNAL_CONTEXT|hidden user input|internal handoff|unknown source|NO_REPLY|HEARTBEAT_OK|heartbeat poll/,
    );
    expect(html).toContain("Visible user request");
    expect(html).toContain("Visible response");
    expect(html).toContain(token);
    expect(html).toContain(operatorSecret);
    expect(html).toContain(`<title>Shared ${token} ${operatorSecret} · OpenClaw</title>`);
  });

  it("groups tool work between every assistant message with bounded unmasked summaries", () => {
    const secret = `sk-${"a".repeat(48)}`;
    const html = render([
      message("assistant", "Checking the files.", { phase: "commentary" }),
      message("assistant", [
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: `cat file ${secret} ${"x".repeat(300)} TAIL_MARKER` },
        },
      ]),
      message("toolResult", "RESULT_BODY_MUST_STAY_PRIVATE"),
      message("assistant", [
        { type: "thinking", thinking: "THOUGHT_MUST_STAY_PRIVATE" },
        { type: "tool_use", name: "read", input: { path: "src/example.ts" } },
      ]),
      message("assistant", "The cause is clear.", { phase: "commentary" }),
      message("assistant", "Fixed the issue.", { phase: "final_answer" }),
    ]);
    expect(html).toContain("Checking the files.");
    expect(html).toContain("The cause is clear.");
    expect(html).toContain("Fixed the issue.");
    expect(html.match(/<details class="tools" data-public-item=/g)).toHaveLength(1);
    expect(html).toContain("Ran 2 tools");
    expect(html).toContain("src/example.ts");
    expect(html).not.toMatch(/RESULT_BODY_MUST_STAY_PRIVATE|THOUGHT_MUST_STAY_PRIVATE|TAIL_MARKER/);
    expect(html).toContain(secret);
    expect(html).not.toContain('<details class="tools" open');
    expect(html.indexOf("Checking the files.")).toBeLessThan(html.indexOf("Ran 2 tools"));
    expect(html.indexOf("Ran 2 tools")).toBeLessThan(html.indexOf("The cause is clear."));
  });

  it("links user, assistant, and tool images only through entry-scoped public media", () => {
    const fileName = `sk-${"a".repeat(48)}.png`;
    const html = render(
      [
        media("user", "user-entry", [
          image({ fileName }),
          { type: "file", fileName: "notes.pdf", url: "file:///private/notes.pdf" },
        ]),
        media("assistant", "assistant-entry", [image()]),
        media("toolResult", "tool-entry", [image(), text("PRIVATE_RESULT")]),
        message("user", [
          text("[Inter-session message] private input"),
          image({ fileName: "HIDDEN_IMAGE" }),
        ]),
      ],
      { mediaBaseUrl: "/control/share/session/media?token=v1.opaque" },
    );
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(html).toContain(`alt="${fileName}"`);
    for (const entry of ["user-entry", "assistant-entry", "tool-entry"]) {
      expect(html).toContain(`&amp;entry=${entry}&amp;attachment=content-0`);
    }
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('<span class="attachment">notes.pdf</span>');
    expect(html).not.toMatch(/PRIVATE_BYTES|PRIVATE_RESULT|file:\/\/|HIDDEN_IMAGE/);
    expect(PUBLIC_SESSION_CONTENT_SECURITY_POLICY).toContain("img-src 'self'");
  });

  it("retains audio-only and video-only messages as filename chips without publishing their media", () => {
    const html = render(
      [
        media("user", "audio-entry", [
          { type: "audio", fileName: "voice-note.mp3", url: "/private/audio" },
        ]),
        media("assistant", "video-entry", [
          { type: "video", fileName: "walkthrough.mp4", url: "/private/video" },
        ]),
        message("toolResult", [
          { type: "audio", fileName: "hidden-audio.mp3", url: "/private/tool-audio" },
          { type: "video", fileName: "hidden-video.mp4", url: "/private/tool-video" },
        ]),
      ],
      { mediaBaseUrl: "/control/share/session/media?token=v1.opaque" },
    );
    expect(html).toContain("2 messages");
    expect(html.match(/<article class="message /g)).toHaveLength(2);
    expect(html).toContain('<span class="attachment">voice-note.mp3</span>');
    expect(html).toContain('<span class="attachment">walkthrough.mp4</span>');
    expect(html).not.toMatch(
      /hidden-audio|hidden-video|\/private\/|<(?:audio|video)\b|&amp;attachment=/,
    );
  });

  it("omits local and remote media directives while preserving fenced examples", () => {
    const relativePath = "./Private/customer-board.pdf";
    const signedUrl = "https://media.example.test/private.png?sig=private-signed-value";
    const html = render(
      [
        "Visible response",
        `MEDIA:${relativePath}`,
        `MEDIA:${signedUrl}`,
        "```text\nMEDIA:./example.png\n```",
      ].join("\n"),
    );
    expect(html).toContain("Visible response");
    expect(html).toContain("MEDIA:./example.png");
    expect(html).not.toContain(relativePath);
    expect(html).not.toContain(signedUrl);
  });

  it("renders inert Markdown without executable markup, automatic image loads, or unsafe links", () => {
    const html = render(
      [
        "<script>alert('unsafe')</script>",
        "![remote image](https://remote.test/tracker.png)",
        "[Safe link](https://example.test/docs)",
        "[Unsafe link](javascript:alert%281%29)",
        "[Local link](/api/private)",
        "```html\n<iframe src='https://remote.test/embed'></iframe>\n```",
      ].join("\n\n"),
      { title: '<img src=x onerror="unsafe">' },
    );
    const transcript = html.slice(
      html.indexOf('<section class="transcript"'),
      html.indexOf("</section>"),
    );
    expect(transcript).toContain("&lt;script&gt;");
    expect(transcript).toContain("&lt;iframe");
    expect(transcript).toContain("[Image omitted]");
    expect(transcript).toContain(
      'href="https://example.test/docs" rel="noreferrer noopener nofollow"',
    );
    expect(transcript).not.toContain("tracker.png");
    expect(transcript).not.toMatch(/<(script|iframe|img)\b/);
    expect(transcript).not.toMatch(/href="(?:javascript:|\/api\/private)/);
    expect(transcript).toContain('<div class="code"><pre><code class="language-html">');
    // The page's only script is the fixed entry script, whose hash the shared policy carries.
    expect(html.match(/<script\b/g)).toHaveLength(1);
    for (const hash of computeInlineScriptHashes(html)) {
      expect(PUBLIC_SESSION_CONTENT_SECURITY_POLICY).toContain(hash);
    }
    expect(PUBLIC_SESSION_CONTENT_SECURITY_POLICY).toContain("font-src 'self'");
    expect(PUBLIC_SESSION_CONTENT_SECURITY_POLICY).toContain("frame-src 'self'");
    expect(html).toContain('<link rel="stylesheet" href="/control/fonts/instrument-sans.css">');
  });

  it("bounds the newest public messages and visibly marks omitted history or text", () => {
    const messages = Array.from({ length: 105 }, (_, index) => ({
      role: "user",
      content: `Message number ${index}.`,
    }));
    messages.push({
      role: "assistant",
      content: `Long message ${"x".repeat(40_000)} private-overflow-marker`,
    });
    const html = render(messages);
    expect(html).not.toContain("Message number 0.");
    expect(html).toContain("Message number 104.");
    expect(html).toContain("Long message");
    expect(html).not.toContain("private-overflow-marker");
    expect(html).toContain("Some messages or long text are omitted");
    expect(html).toContain("Message shortened for this public view");
    expect(html.indexOf("Message number 104.")).toBeLessThan(html.indexOf("Long message"));
  });

  it("keeps whole characters when the document budget leaves one code unit", () => {
    const html = render([
      { role: "user", content: "🙂 visible tail" },
      { role: "user", content: "b".repeat(32_767) },
      ...Array.from({ length: 7 }, () => ({ role: "user", content: "a".repeat(32_768) })),
    ]);
    expect(html.isWellFormed()).toBe(true);
    expect(html).not.toContain("visible tail");
    expect(html).toContain("Message shortened for this public view.");
  });
});
