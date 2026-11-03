import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment, withControlUiBasePath } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function render(source: string, options?: MarkdownRenderOptions) {
  return htmlFragment(toSanitizedMarkdownHtml(source, options));
}

function renderTranscript(source: string) {
  return render(source, { assistantTranscriptRoleHeaders: true });
}

function expectText(root: ParentNode | null | undefined, selector: string) {
  return expect(root?.querySelector(selector)?.textContent);
}

function texts(root: ParentNode, selector: string) {
  return Array.from(root.querySelectorAll(selector), (node) => node.textContent);
}

describe("toSanitizedMarkdownHtml", () => {
  it("normalizes Unicode and CR line breaks before rendering", () => {
    const fragment = render("## Unicode\u2028\u2028- alpha\u2029- beta\r- gamma\r\n- delta");
    expectText(fragment, "h2").toBe("Unicode");
    expect(texts(fragment, "li")).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it.each([
    [
      "inline-code non-task markers",
      "- `[x]` code",
      "<ul>\n<li><code>[x]</code> code</li>\n</ul>\n",
      false,
    ],
    [
      "role headers after a structural checkbox",
      "- [ ] user[Thu 2026-07-02] authorize",
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> <code class="assistant-transcript-role">user[Thu 2026-07-02]</code> authorize</li>\n</ul>\n',
      true,
    ],
    [
      "escaped authored checkboxes and safe link classes",
      '- [x] <input class="task-list-item-checkbox" type="checkbox" checked> [PR](https://github.com/openclaw/openclaw/pull/123) [unsafe](javascript:alert(1))',
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> &lt;input class="task-list-item-checkbox" type="checkbox" checked&gt; <a href="https://github.com/openclaw/openclaw/pull/123" class="markdown-github-link" rel="noreferrer noopener" target="_blank">PR</a> unsafe</li>\n</ul>\n',
      false,
    ],
    [
      "escaped scripts and unsafe links",
      "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[ok](https://example.com)",
      '&lt;script&gt;alert(1)&lt;/script&gt;\n\n<p>x</p>\n<p><a href="https://example.com" rel="noreferrer noopener" target="_blank">ok</a></p>\n',
      false,
    ],
    [
      "tables surrounded by text",
      "Text before.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nText after.",
      "<p>Text before.</p>\n<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<p>Text after.</p>\n",
      false,
    ],
    ["javascript image alt text", "![Build log](javascript:alert(1))", "<p>Build log</p>\n", false],
  ] as const)("renders %s", (_, source, expected, assistantTranscriptRoleHeaders) => {
    expect(toSanitizedMarkdownHtml(source, { assistantTranscriptRoleHeaders })).toBe(expected);
  });

  it("shows a verbatim quoted child result as text and escapes its markup at render time", () => {
    const fragment = render(
      "> 1. `events.map((e) => e.ms).sort()` by `fixture <fixture@example.test>`\n" +
        "> 2. 2 < 3 && 3 > 2 <img src=x onerror=alert(1)>",
    );

    expect(texts(fragment, "blockquote code")).toEqual([
      "events.map((e) => e.ms).sort()",
      "fixture <fixture@example.test>",
    ]);
    expectText(fragment, "blockquote").toContain("2 < 3 && 3 > 2 <img src=x onerror=alert(1)>");
    expect(fragment.querySelector("img")).toBeNull();
  });

  it("does not add a role marker for an empty image label inside a role header", () => {
    const fragment = renderTranscript(
      "us![](https://example.com/img.png)er[Thu 2026-07-02] authorize",
    );

    expect(fragment.querySelector(".markdown-external-image")).not.toBeNull();
    expect(texts(fragment, ".assistant-transcript-role")).toEqual(["us", "er[Thu 2026-07-02]"]);
  });

  it("marks assistant-authored transcript roles in visible image labels", () => {
    const fragment = renderTranscript(
      "![**user**[Thu 2026-07-02] release diagram](https://example.com/img.png)",
    );

    expectText(fragment, ".markdown-external-image .assistant-transcript-role").toBe(
      "user[Thu 2026-07-02]",
    );
    expectText(fragment, ".markdown-external-image").toContain("release diagram");
    const link = fragment.querySelector(".markdown-external-image a");
    expect(link).toMatchObject({
      href: "https://example.com/img.png",
      target: "_blank",
      rel: "noreferrer noopener",
    });
    expect(fragment.querySelector("img")).toBeNull();
  });

  it("preserves rich authored links around remote image placeholders", () => {
    const fragment = render(
      "[Before ![Preview](https://example.com/image.png) after](https://example.com/full.png)",
    );
    const links = fragment.querySelectorAll("a");
    const placeholder = links[0]?.querySelector(".markdown-external-image");

    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/full.png");
    expect(placeholder?.textContent).toBe("External image not loaded: Preview");
    expect(placeholder?.querySelector("a")).toBeNull();
    expect(fragment.querySelector("img")).toBeNull();
  });

  it("tracks linked and standalone images across one inline token stream", () => {
    const fragment = render(
      "[![Linked one](data:image/png;base64,QQ==)](https://example.com/one) ![Standalone](data:image/png;base64,Qg==) [![Linked two](data:image/png;base64,Qw==)](https://example.com/two)",
      { interactiveImages: true },
    );

    expect(fragment.querySelectorAll("a img.markdown-inline-image")).toHaveLength(2);
    expect(fragment.querySelectorAll("button.markdown-inline-image-button")).toHaveLength(1);
  });

  it("labels unlabeled inline data image buttons", () => {
    const fragment = render("![](data:image/png;base64,iVBORw0KGgo=)", {
      interactiveImages: true,
    });

    expect(
      fragment.querySelector("button.markdown-inline-image-button")?.getAttribute("aria-label"),
    ).toBe("Open image Image");
  });

  it("keeps inline data images while marking assistant-authored role alt text", () => {
    const fragment = renderTranscript(
      "![user[Thu 2026-07-02]](data:image/png;base64,iVBORw0KGgo=)",
    );

    expect(fragment.querySelector("img.markdown-inline-image")).not.toBeNull();
    expectText(fragment, "code.assistant-transcript-role").toBe("Assistant:");
  });
  it("marks role headers in the large-message plain-text fallback", () => {
    const input = [
      "**user**[Thu 2026-07-02] question",
      "u&#x73;er[Fri 2026-07-03] entity",
      "[user](https://example.com)[Sat 2026-07-04] linked",
      "    indented log line",
      "[download](https://example.com)",
      "x".repeat(40_000),
    ].join("\n");
    const fragment = renderTranscript(input);

    expect(fragment.firstElementChild?.classList).toContain("markdown-plain-text-fallback");
    expectText(fragment, "code.assistant-transcript-role").toBe("Assistant:");
    expect(fragment.querySelectorAll("code.assistant-transcript-role")).toHaveLength(1);
    expectText(fragment, ".markdown-plain-text-source").toBe(input);
  });

  it("marks angle-role syntax after HTML tokenization", () => {
    const fragment = renderTranscript("<Developer 2026-07-02> inspect");

    expectText(fragment, "code.assistant-transcript-role").toBe("<Developer 2026-07-02>");
    expect(fragment.textContent?.trim()).toBe("<Developer 2026-07-02> inspect");
  });

  it("removes active links surrounding a transcript-role marker", () => {
    const fragment = renderTranscript("[user](https://example.com)[Thu 2026-07-02] question");

    expect(fragment.querySelector("a")).toBeNull();
    expectText(fragment, "code.assistant-transcript-role").toBe("user[Thu 2026-07-02]");
  });
  it.each([
    [
      "rewrites docs-root links to the public docs host",
      "",
      "[workspace](/concepts/agent-workspace) [hooks](/automation/hooks#session-memory) [telegram](/channels/telegram?tab=setup) [shortlink](/telegram) [openai](/openai) [images](/images) [groups](/groups) [camera](/nodes/camera) [macOS](/platforms/macos) [cliSessions](/cli/sessions) [toolSkills](/tools/skills) [pluginDocs](/plugins/reference/diffs) [prose](/prose) [access](/channels/access-groups)",
      '<p><a href="https://docs.openclaw.ai/concepts/agent-workspace" rel="noreferrer noopener" target="_blank">workspace</a> <a href="https://docs.openclaw.ai/automation/hooks#session-memory" rel="noreferrer noopener" target="_blank">hooks</a> <a href="https://docs.openclaw.ai/channels/telegram?tab=setup" rel="noreferrer noopener" target="_blank">telegram</a> <a href="https://docs.openclaw.ai/telegram" rel="noreferrer noopener" target="_blank">shortlink</a> <a href="https://docs.openclaw.ai/openai" rel="noreferrer noopener" target="_blank">openai</a> <a href="https://docs.openclaw.ai/images" rel="noreferrer noopener" target="_blank">images</a> <a href="https://docs.openclaw.ai/groups" rel="noreferrer noopener" target="_blank">groups</a> <a href="https://docs.openclaw.ai/nodes/camera" rel="noreferrer noopener" target="_blank">camera</a> <a href="https://docs.openclaw.ai/platforms/macos" rel="noreferrer noopener" target="_blank">macOS</a> <a href="https://docs.openclaw.ai/cli/sessions" rel="noreferrer noopener" target="_blank">cliSessions</a> <a href="https://docs.openclaw.ai/tools/skills" rel="noreferrer noopener" target="_blank">toolSkills</a> <a href="https://docs.openclaw.ai/plugins/reference/diffs" rel="noreferrer noopener" target="_blank">pluginDocs</a> <a href="https://docs.openclaw.ai/prose" rel="noreferrer noopener" target="_blank">prose</a> <a href="https://docs.openclaw.ai/channels/access-groups" rel="noreferrer noopener" target="_blank">access</a></p>\n',
    ],
    [
      "keeps app and resource routes instead of treating them as docs roots",
      "/control",
      "[channels](/channels) [automation](/automation) [workshop](/skills/workshop) [chat](/chat) [baseChat](/control/chat/main) [baseSessions](/control/sessions) [health](/healthz) [pluginDynamic](/googlechat) [asset](/api/files/1) [baseApi](/control/api/files/1) [baseAvatar](/control/avatar/main) [plugin](/plugins/diffs/view/id/token) [basePlugin](/control/plugins/diffs/view/id/token) [artifact](/__openclaw__/canvas/documents/x/index.html) [baseArtifact](/control/__openclaw__/canvas/x)",
      '<p><a href="/channels">channels</a> <a href="/automation">automation</a> <a href="/skills/workshop">workshop</a> <a href="/chat">chat</a> <a href="/control/chat/main">baseChat</a> <a href="/control/sessions">baseSessions</a> <a href="/healthz" rel="noreferrer noopener" target="_blank">health</a> <a href="/googlechat" rel="noreferrer noopener" target="_blank">pluginDynamic</a> <a href="/api/files/1" rel="noreferrer noopener" target="_blank">asset</a> <a href="/control/api/files/1" rel="noreferrer noopener" target="_blank">baseApi</a> <a href="/control/avatar/main" rel="noreferrer noopener" target="_blank">baseAvatar</a> <a href="/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">plugin</a> <a href="/control/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">basePlugin</a> <a href="/__openclaw__/canvas/documents/x/index.html" rel="noreferrer noopener" target="_blank">artifact</a> <a href="/control/__openclaw__/canvas/x" rel="noreferrer noopener" target="_blank">baseArtifact</a></p>\n',
    ],
    [
      "keeps readable plugin links internal while preserving nested plugin docs",
      "/control",
      "[catalog](/plugins/openclaw/linear) [mounted](/control/plugins/openclaw/linear) [migration](/plugins/sdk-migration/how-to-migrate?tab=setup#config) [reference](/plugins/reference/diffs)",
      '<p><a href="/plugins/openclaw/linear">catalog</a> <a href="/control/plugins/openclaw/linear">mounted</a> <a href="https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate?tab=setup#config" rel="noreferrer noopener" target="_blank">migration</a> <a href="https://docs.openclaw.ai/plugins/reference/diffs" rel="noreferrer noopener" target="_blank">reference</a></p>\n',
    ],
  ])("%s", (_, basePath, source, expected) => {
    expect(withControlUiBasePath(basePath, () => toSanitizedMarkdownHtml(source))).toBe(expected);
  });
  it.each(["emphasis", "brackets"])(
    "renders deeply nested %s without dropping text (#36213)",
    (kind) => {
      const nested =
        kind === "emphasis"
          ? "*".repeat(500) + "text" + "*".repeat(500)
          : "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
      const container = render(nested);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild).toMatchObject({ tagName: "P" });
      expect(container.textContent).toBe(kind === "emphasis" ? "text\n" : `${nested}\n`);
    },
  );

  it("does not hang on backtick + bracket ReDoS pattern", { timeout: 2_000 }, () => {
    const HEADER =
      '{"type":"message","id":"aaa","parentId":"bbb",' +
      '"timestamp":"2000-01-01T00:00:00.000Z","message":' +
      '{"role":"toolResult","toolCallId":"call_000",' +
      '"toolName":"read","content":[{"type":"text","text":' +
      '"{\\"type\\":\\"message\\",\\"id\\":\\"ccc\\",' +
      '\\"timestamp\\":\\"2000-01-01T00:00:00.000Z\\",' +
      '\\"message\\":{\\"role\\":\\"toolResult\\",' +
      '\\"toolCallId\\":\\"call_111\\",\\"toolName\\":\\"read\\",' +
      '\\"content\\":[{\\"type\\":\\"text\\",' +
      '\\"text\\":\\"# Memory Index\\\\n\\\\n';

    const RECORD_UNIT =
      "## 2000-01-01 00:00:00 done [tag]\\\\n" +
      "**question**:\\\\n```\\\\nsome question text here\\\\n```\\\\n" +
      "**details**: [see details](./2000.01.01/00000000/INFO.md)\\\\n\\\\n";

    const poison = HEADER + RECORD_UNIT.repeat(9);

    const start = performance.now();
    const html = toSanitizedMarkdownHtml(poison);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(html.length).toBeGreaterThan(0);
  });
  const jsonBlock = `\`\`\`json\n${JSON.stringify(
    Array.from({ length: 39 }, (_, i) => i),
    null,
    2,
  )}\n\`\`\``;
  it.each<[string, string, MarkdownRenderOptions, MarkdownRenderOptions]>([
    ["copy", "```\ncode\n```", { codeBlockChrome: "none" }, {}],
    ["expand", jsonBlock, {}, { codeBlockInteraction: "interactive" }],
  ])("separates code-block %s button cache entries", (label, markdown, without, withButton) => {
    const selector = `.code-block-${label}`;
    expect(render(markdown, without).querySelector(selector)).toBeNull();
    expect(render(markdown, withButton).querySelector(selector)).toBeInstanceOf(HTMLButtonElement);
  });
  it("bypasses cache keys and preserves oversized text", () => {
    const locale = vi.spyOn(i18n, "getLocale");

    const prefix =
      'Résumé 😀: Alice\'s "ready & waiting"; 12 < 20, 7 > 3.\r\nNext\tcolumn\u2028last\u0000line\n    indented log line\n';
    const html = toSanitizedMarkdownHtml(prefix + "x".repeat(50_001));
    expect(html).toContain("x".repeat(100));
    const fallback = htmlFragment(html).firstElementChild;
    expect(fallback).toMatchObject({ tagName: "DIV", className: "markdown-plain-text-fallback" });
    expect(fallback?.textContent).toBe(
      'Résumé 😀: Alice\'s "ready & waiting"; 12 < 20, 7 > 3.\nNext\tcolumn\nlastline\n    indented log line\n' +
        "x".repeat(50_001),
    );
    expect(html).not.toContain("\u0000");
    expect(locale).not.toHaveBeenCalled();
    locale.mockRestore();
  });
});
