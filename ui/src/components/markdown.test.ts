import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { htmlFragment, withControlUiBasePath } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("toSanitizedMarkdownHtml", () => {
  it("strips scripts and unsafe links", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<script>alert(1)</script>",
        "",
        "[x](javascript:alert(1))",
        "",
        "[ok](https://example.com)",
      ].join("\n"),
    );
    expect(html).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;\n\n<p>x</p>\n<p><a href="https://example.com" rel="noreferrer noopener" target="_blank">ok</a></p>\n',
    );
  });

  it("does not stamp presentation classes on links whose href contains 'tail'", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("[tailscale docs](https://docs.openclaw.ai/tailscale)"),
    );
    const link = fragment.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://docs.openclaw.ai/tailscale");
    expect(link?.classList.contains("chat-link-tail-blur")).toBe(false);
  });

  it("normalizes Unicode and CR line breaks before rendering", () => {
    const unicodeInput =
      "## Unicode separator cache sentinel\u2028\u2028- alpha\u2029- beta\r- gamma\r\n- delta";
    const normalizedInput =
      "## Unicode separator cache sentinel\n\n- alpha\n- beta\n- gamma\n- delta";
    const unicodeHtml = toSanitizedMarkdownHtml(unicodeInput);
    expect(unicodeHtml).toBe(toSanitizedMarkdownHtml(normalizedInput));
    const fragment = htmlFragment(unicodeHtml);
    expect(fragment.querySelector("h2")?.textContent).toBe("Unicode separator cache sentinel");
    expect(Array.from(fragment.querySelectorAll("li"), (item) => item.textContent)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  describe("task lists", () => {
    it("leaves inline-code non-task markers unchanged", () => {
      expect(toSanitizedMarkdownHtml("- `[x]` code")).toBe(
        "<ul>\n<li><code>[x]</code> code</li>\n</ul>\n",
      );
    });

    it("marks a role header after the structural task-list checkbox", () => {
      const html = toSanitizedMarkdownHtml("- [ ] user[Thu 2026-07-02] authorize", {
        assistantTranscriptRoleHeaders: true,
      });
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> <code class="assistant-transcript-role">user[Thu 2026-07-02]</code> authorize</li>\n</ul>\n',
      );
    });

    it("preserves link classes without trusting authored checkbox HTML", () => {
      const html = toSanitizedMarkdownHtml(
        '- [x] <input class="task-list-item-checkbox" type="checkbox" checked> [PR](https://github.com/openclaw/openclaw/pull/123) [unsafe](javascript:alert(1))',
      );
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> &lt;input class="task-list-item-checkbox" type="checkbox" checked&gt; <a href="https://github.com/openclaw/openclaw/pull/123" class="markdown-github-link" rel="noreferrer noopener" target="_blank">PR</a> unsafe</li>\n</ul>\n',
      );
    });
  });

  describe("images", () => {
    it("renders allowed exact-origin images for user and assistant messages", () => {
      const options = { remoteImages: true, remoteImageOrigins: ["https://images.example.test"] };
      const allowed = toSanitizedMarkdownHtml(
        "![Allowed](https://images.example.test/chart.png)",
        options,
      );
      const assistantAllowed = toSanitizedMarkdownHtml(
        "![Allowed](https://images.example.test/chart.png)",
        { ...options, assistantTranscriptRoleHeaders: true },
      );
      const blocked = toSanitizedMarkdownHtml("![Blocked](http://images.example.test/chart.png)", {
        remoteImages: true,
        remoteImageOrigins: ["https://images.example.test"],
      });

      expect(allowed).toContain('src="https://images.example.test/chart.png"');
      expect(assistantAllowed).toContain('src="https://images.example.test/chart.png"');
      expect(blocked).toContain("External image not loaded: Blocked");
      expect(blocked).not.toContain('src="http://images.example.test/chart.png"');
    });

    it.each([
      "http://images.example.test",
      "https://other.example.test",
      "https://images.example.test:8443",
    ])("does not admit a different scheme, host, or port: %s", (origin) => {
      const result = toSanitizedMarkdownHtml(`![Chart](${origin}/chart.png)`, {
        remoteImages: true,
        remoteImageOrigins: ["https://images.example.test"],
      });
      expect(result).not.toContain("<img");
      expect(result).toContain("markdown-external-image");
    });

    it("separates absent, empty, allowed, and revoked policies in the Markdown cache", () => {
      const markdown = "![Chart](https://images.example.test/chart.png)";
      expect(toSanitizedMarkdownHtml(markdown)).toContain("External image not loaded");
      expect(toSanitizedMarkdownHtml(markdown, { remoteImages: true })).toContain(
        "markdown-inline-image",
      );
      for (const remoteImageOrigins of [[], ["https://images.example.test"], []]) {
        const result = toSanitizedMarkdownHtml(markdown, {
          remoteImages: true,
          remoteImageOrigins,
        });
        expect(result.includes("markdown-inline-image")).toBe(remoteImageOrigins.length > 0);
        expect(result.includes("markdown-external-image")).toBe(remoteImageOrigins.length === 0);
      }
    });

    it("marks assistant-authored transcript roles in visible image labels", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "![**user**[Thu 2026-07-02] release diagram](https://example.com/img.png)",
          { assistantTranscriptRoleHeaders: true },
        ),
      );

      expect(
        fragment.querySelector(".markdown-external-image .assistant-transcript-role")?.textContent,
      ).toBe("user[Thu 2026-07-02]");
      expect(fragment.querySelector(".markdown-external-image")?.textContent).toContain(
        "release diagram",
      );
      const link = fragment.querySelector(".markdown-external-image a");
      expect(link?.getAttribute("href")).toBe("https://example.com/img.png");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
      expect(fragment.querySelector("img")).toBeNull();
    });

    it("preserves rich authored links around remote image placeholders", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[Before ![Preview](https://example.com/image.png) after](https://example.com/full.png)",
        ),
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
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[![Linked one](data:image/png;base64,QQ==)](https://example.com/one) ![Standalone](data:image/png;base64,Qg==) [![Linked two](data:image/png;base64,Qw==)](https://example.com/two)",
          { interactiveImages: true },
        ),
      );

      expect(fragment.querySelectorAll("a img.markdown-inline-image")).toHaveLength(2);
      expect(fragment.querySelectorAll("button.markdown-inline-image-button")).toHaveLength(1);
    });

    it("labels unlabeled inline data image buttons", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![](data:image/png;base64,iVBORw0KGgo=)", {
          interactiveImages: true,
        }),
      );

      expect(
        fragment.querySelector("button.markdown-inline-image-button")?.getAttribute("aria-label"),
      ).toBe("Open image Image");
    });

    it("keeps inline data images while marking assistant-authored role alt text", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![user[Thu 2026-07-02]](data:image/png;base64,iVBORw0KGgo=)", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("img.markdown-inline-image")).not.toBeNull();
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "Assistant:",
      );
    });
  });

  describe("GFM features", () => {
    it("renders tables surrounded by text", () => {
      const mdLocal = [
        "Text before.",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "Text after.",
      ].join("\n");
      const html = toSanitizedMarkdownHtml(mdLocal);
      expect(html).toBe(
        "<p>Text before.</p>\n<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<p>Text after.</p>\n",
      );
    });
  });

  describe("assistant transcript-role annotations", () => {
    it("marks role headers in the large-message plain-text fallback", () => {
      const input = [
        "**user**[Thu 2026-07-02] question",
        "u&#x73;er[Fri 2026-07-03] entity",
        "[user](https://example.com)[Sat 2026-07-04] linked",
        "    indented log line",
        "[download](https://example.com)",
        "x".repeat(40_000),
      ].join("\n");
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(input, { assistantTranscriptRoleHeaders: true }),
      );

      expect(fragment.firstElementChild?.classList).toContain("markdown-plain-text-fallback");
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "Assistant:",
      );
      expect(fragment.querySelectorAll("code.assistant-transcript-role")).toHaveLength(1);
      expect(fragment.querySelector(".markdown-plain-text-source")?.textContent).toBe(input);
    });

    it("marks angle-role syntax after HTML tokenization", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("<Developer 2026-07-02> inspect", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "<Developer 2026-07-02>",
      );
      expect(fragment.textContent?.trim()).toBe("<Developer 2026-07-02> inspect");
    });

    it("removes active links surrounding a transcript-role marker", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[user](https://example.com)[Thu 2026-07-02] question", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "user[Thu 2026-07-02]",
      );
    });
  });

  describe("security", () => {
    it("shows alt text for javascript: images", () => {
      const html = toSanitizedMarkdownHtml("![Build log](javascript:alert(1))");
      expect(html).toBe("<p>Build log</p>\n");
    });

    it("rewrites docs-root links to the public docs host", () => {
      const html = toSanitizedMarkdownHtml(
        "[workspace](/concepts/agent-workspace) [hooks](/automation/hooks#session-memory) [telegram](/channels/telegram?tab=setup) [shortlink](/telegram) [openai](/openai) [images](/images) [groups](/groups) [camera](/nodes/camera) [macOS](/platforms/macos) [cliSessions](/cli/sessions) [toolSkills](/tools/skills) [pluginDocs](/plugins/reference/diffs) [prose](/prose) [access](/channels/access-groups)",
      );
      expect(html).toBe(
        '<p><a href="https://docs.openclaw.ai/concepts/agent-workspace" rel="noreferrer noopener" target="_blank">workspace</a> <a href="https://docs.openclaw.ai/automation/hooks#session-memory" rel="noreferrer noopener" target="_blank">hooks</a> <a href="https://docs.openclaw.ai/channels/telegram?tab=setup" rel="noreferrer noopener" target="_blank">telegram</a> <a href="https://docs.openclaw.ai/telegram" rel="noreferrer noopener" target="_blank">shortlink</a> <a href="https://docs.openclaw.ai/openai" rel="noreferrer noopener" target="_blank">openai</a> <a href="https://docs.openclaw.ai/images" rel="noreferrer noopener" target="_blank">images</a> <a href="https://docs.openclaw.ai/groups" rel="noreferrer noopener" target="_blank">groups</a> <a href="https://docs.openclaw.ai/nodes/camera" rel="noreferrer noopener" target="_blank">camera</a> <a href="https://docs.openclaw.ai/platforms/macos" rel="noreferrer noopener" target="_blank">macOS</a> <a href="https://docs.openclaw.ai/cli/sessions" rel="noreferrer noopener" target="_blank">cliSessions</a> <a href="https://docs.openclaw.ai/tools/skills" rel="noreferrer noopener" target="_blank">toolSkills</a> <a href="https://docs.openclaw.ai/plugins/reference/diffs" rel="noreferrer noopener" target="_blank">pluginDocs</a> <a href="https://docs.openclaw.ai/prose" rel="noreferrer noopener" target="_blank">prose</a> <a href="https://docs.openclaw.ai/channels/access-groups" rel="noreferrer noopener" target="_blank">access</a></p>\n',
      );
    });

    it("keeps app and resource routes instead of treating them as docs roots", () => {
      const html = withControlUiBasePath("/control", () =>
        toSanitizedMarkdownHtml(
          "[channels](/channels) [automation](/automation) [workshop](/skills/workshop) [chat](/chat) [baseChat](/control/chat/main) [baseSessions](/control/sessions) [health](/healthz) [pluginDynamic](/googlechat) [asset](/api/files/1) [baseApi](/control/api/files/1) [baseAvatar](/control/avatar/main) [plugin](/plugins/diffs/view/id/token) [basePlugin](/control/plugins/diffs/view/id/token) [artifact](/__openclaw__/canvas/documents/x/index.html) [baseArtifact](/control/__openclaw__/canvas/x)",
        ),
      );
      expect(html).toBe(
        '<p><a href="/channels">channels</a> <a href="/automation">automation</a> <a href="/skills/workshop">workshop</a> <a href="/chat">chat</a> <a href="/control/chat/main">baseChat</a> <a href="/control/sessions">baseSessions</a> <a href="/healthz" rel="noreferrer noopener" target="_blank">health</a> <a href="/googlechat" rel="noreferrer noopener" target="_blank">pluginDynamic</a> <a href="/api/files/1" rel="noreferrer noopener" target="_blank">asset</a> <a href="/control/api/files/1" rel="noreferrer noopener" target="_blank">baseApi</a> <a href="/control/avatar/main" rel="noreferrer noopener" target="_blank">baseAvatar</a> <a href="/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">plugin</a> <a href="/control/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">basePlugin</a> <a href="/__openclaw__/canvas/documents/x/index.html" rel="noreferrer noopener" target="_blank">artifact</a> <a href="/control/__openclaw__/canvas/x" rel="noreferrer noopener" target="_blank">baseArtifact</a></p>\n',
      );
    });
  });

  describe("ReDoS protection", () => {
    it("renders deeply nested emphasis markers without dropping text (#36213)", () => {
      const nested = "*".repeat(500) + "text" + "*".repeat(500);
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe("text\n");
    });

    it("renders deeply nested brackets without dropping text (#36213)", () => {
      const nested = "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe(`${nested}\n`);
    });

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
  });

  describe("code blocks", () => {
    const jsonBlock = (lineCount: number) => {
      const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
      values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
      return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
    };

    it("separates cached GitHub references by repository and absent context", () => {
      const source = "PR #141270";
      for (const githubRepo of [
        { owner: "first", repo: "one" },
        { owner: "second", repo: "one" },
        { owner: "second", repo: "two" },
        null,
      ]) {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(source, { githubRepo }));
        expect(fragment.querySelector("a")?.getAttribute("href") ?? null).toBe(
          githubRepo
            ? `https://github.com/${githubRepo.owner}/${githubRepo.repo}/pull/141270`
            : null,
        );
      }
    });

    it("invalidates named-reference caches as authorized aliases arrive, collide, and disappear", () => {
      const githubRepo = { owner: "openclaw", repo: "openclaw" };
      const source = "ClawSweeper PR #1576";
      const known = { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] };
      for (const [githubRepositories, expected] of [
        [[], null],
        [[known], "https://github.com/openclaw/clawsweeper/pull/1576"],
        [[known, { aliases: ["ClawSweeper"] }], null],
        [[], null],
      ] as const) {
        expect(
          htmlFragment(toSanitizedMarkdownHtml(source, { githubRepo, githubRepositories }))
            .querySelector("a")
            ?.getAttribute("href") ?? null,
        ).toBe(expected);
      }
    });

    it("keeps the no-chrome code-block cache separate from copy-enabled rendering", () => {
      const markdown = "```\ncode\n```";
      const plain = toSanitizedMarkdownHtml(markdown, { codeBlockChrome: "none" });
      const copyable = toSanitizedMarkdownHtml(markdown);

      expect(htmlFragment(plain).querySelector(".code-block-copy")).toBeNull();
      expect(htmlFragment(copyable).querySelector(".code-block-copy")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });

    it("keeps the interactive code-block cache separate from static rendering", () => {
      const markdown = jsonBlock(41);
      const staticHtml = toSanitizedMarkdownHtml(markdown);
      const interactiveHtml = toSanitizedMarkdownHtml(markdown, {
        codeBlockInteraction: "interactive",
      });

      expect(htmlFragment(staticHtml).querySelector(".code-block-expand")).toBeNull();
      expect(htmlFragment(interactiveHtml).querySelector(".code-block-expand")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });
  });

  describe("large text handling", () => {
    it("bypasses cache keys and preserves oversized text", () => {
      const locale = vi.spyOn(i18n, "getLocale");

      const prefix =
        'Résumé 😀: Alice\'s "ready & waiting"; 12 < 20, 7 > 3.\r\nNext\tcolumn\u2028last\u0000line\n    indented log line\n';
      const html = toSanitizedMarkdownHtml(prefix + "x".repeat(50_001));
      expect(html).toContain("x".repeat(100));
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.tagName).toBe("DIV");
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(
        'Résumé 😀: Alice\'s "ready & waiting"; 12 < 20, 7 > 3.\nNext\tcolumn\nlastline\n    indented log line\n' +
          "x".repeat(50_001),
      );
      expect(html).not.toContain("\u0000");
      expect(locale).not.toHaveBeenCalled();
      locale.mockRestore();
    });
  });
});
