// Control UI tests cover markdown link rendering: autolinking, file links, and link marks.
import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toSanitizedMarkdownHtml links", () => {
  describe("www autolinks", () => {
    it("links www.example.com with path, query, and fragment", () => {
      const html = toSanitizedMarkdownHtml("See www.example.com/path?a=1#section");
      expect(html).toBe(
        '<p>See <a href="http://www.example.com/path?a=1#section" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path?a=1#section</a></p>\n',
      );
    });

    it("links www.localhost and other single-label hosts", () => {
      const html = toSanitizedMarkdownHtml("Visit www.localhost:3000/path for dev");
      expect(html).toBe(
        '<p>Visit <a href="http://www.localhost:3000/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.localhost:3000/path</a> for dev</p>\n',
      );
    });

    it("links Unicode/IDN domains like www.münich.de", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.münich.de");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.xn--mnich-kva.de" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.münich.de</a></p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("Visit www.café.example");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.xn--caf-dma.example" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.café.example</a></p>\n',
      );
    });

    it("links www.foo_bar.example.com with underscores", () => {
      const html = toSanitizedMarkdownHtml("Visit www.foo_bar.example.com");
      expect(html).toBe(
        '<p>Visit <a href="http://www.foo_bar.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.foo_bar.example.com</a></p>\n',
      );
    });

    it("strips trailing punctuation from links", () => {
      const html1 = toSanitizedMarkdownHtml("Check www.example.com/help.");
      expect(html1).toBe(
        '<p>Check <a href="http://www.example.com/help" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/help</a>.</p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("See www.example.com!");
      expect(html2).toBe(
        '<p>See <a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>!</p>\n',
      );
    });

    it("strips entity-like suffixes per GFM spec", () => {
      // &hl; looks like an entity reference, so strip it
      const html1 = toSanitizedMarkdownHtml("www.google.com/search?q=commonmark&hl;");
      expect(html1).toBe(
        '<p><a href="http://www.google.com/search?q=commonmark" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.google.com/search?q=commonmark</a>&amp;hl;</p>\n',
      );

      // &amp; is also entity-like
      const html2 = toSanitizedMarkdownHtml("www.example.com/path&amp;");
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&amp;</p>\n',
      );
    });

    it("handles quotes with balance checking", () => {
      // Quoted URL — trailing unbalanced " is stripped
      const html1 = toSanitizedMarkdownHtml('"www.example.com"');
      expect(html1).toBe(
        '<p>"<a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>"</p>\n',
      );

      // Balanced quotes inside path — preserved
      const html2 = toSanitizedMarkdownHtml('www.example.com/path"with"quotes');
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path%22with%22quotes" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path"with"quotes</a></p>\n',
      );

      // Trailing unbalanced " — stripped
      const html3 = toSanitizedMarkdownHtml('www.example.com/path"');
      expect(html3).toBe(
        '<p><a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>"</p>\n',
      );
    });

    it("does NOT link www. domains starting with non-ASCII", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.ünich.de");
      expect(html1).toBe("<p>Visit www.ünich.de</p>\n");

      const html2 = toSanitizedMarkdownHtml("Visit www.ñoño.com");
      expect(html2).toBe("<p>Visit www.ñoño.com</p>\n");
    });

    it("handles balanced parentheses in URLs", () => {
      const html = toSanitizedMarkdownHtml("(see www.example.com/foo(bar))");
      expect(html).toBe(
        '<p>(see <a href="http://www.example.com/foo(bar)" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/foo(bar)</a>)</p>\n',
      );
    });

    it("stops at < character", () => {
      // Stops at < character
      const html1 = toSanitizedMarkdownHtml("Visit www.example.com/path<test");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&lt;test</p>\n',
      );

      // <tag> pattern — stops before <
      const html2 = toSanitizedMarkdownHtml("Visit www.example.com/<token> here");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.example.com/" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/</a>&lt;token&gt; here</p>\n',
      );
    });

    it("does NOT link bare domains without www", () => {
      const html = toSanitizedMarkdownHtml("Visit google.com today");
      expect(html).toBe("<p>Visit google.com today</p>\n");
    });

    it("does NOT link filenames with TLD-like extensions", () => {
      const html = toSanitizedMarkdownHtml("Check README.md and config.json");
      expect(html).toBe("<p>Check README.md and config.json</p>\n");
    });

    it("does NOT link IP addresses", () => {
      const html = toSanitizedMarkdownHtml("Check 127.0.0.1:8080");
      expect(html).toBe("<p>Check 127.0.0.1:8080</p>\n");
    });

    it("keeps adjacent trailing CJK text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.com重新解读");
      expect(html).toBe(
        '<p><a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>重新解读</p>\n',
      );
    });

    it("keeps Japanese text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.comテスト");
      expect(html).toBe(
        '<p><a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>テスト</p>\n',
      );
    });
  });

  describe("explicit protocol links", () => {
    it("links http:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit http://github.com/openclaw");
      expect(html).toBe(
        '<p>Visit <a href="http://github.com/openclaw" class="markdown-bare-url markdown-github-link" title="http://github.com/openclaw" rel="noreferrer noopener" target="_blank">github.com/openclaw</a></p>\n',
      );
    });

    it("keeps CJK text outside https:// links with path", () => {
      const html = toSanitizedMarkdownHtml("https://example.com/path重新解读");
      expect(html).toBe(
        '<p><a href="https://example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/path</a>重新解读</p>\n',
      );
    });

    it("preserves mid-URL CJK in https:// links", () => {
      // CJK in the middle of a URL path (not trailing) must not be trimmed
      const html = toSanitizedMarkdownHtml("https://example.com/你/test");
      expect(html).toBe(
        '<p><a href="https://example.com/%E4%BD%A0/test" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/你/test</a></p>\n',
      );
    });

    it("preserves percent-encoded CJK inside URLs when no raw CJK present", () => {
      // Percent-encoded paths without raw CJK are preserved as-is
      const html = toSanitizedMarkdownHtml("https://example.com/path/%E4%BD%A0%E5%A5%BD");
      expect(html).toBe(
        '<p><a href="https://example.com/path/" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/path/</a>你好</p>\n',
      );
      // markdown-it linkify decodes percent-encoded CJK for display, then our
      // CJK trim rule splits at the first raw CJK char. This is acceptable
      // because raw percent-encoded CJK in chat is extremely rare.
    });

    it("does NOT rewrite explicit markdown links with CJK display text", () => {
      const html = toSanitizedMarkdownHtml("[OpenClaw中文](https://docs.openclaw.ai)");
      expect(html).toBe(
        '<p><a href="https://docs.openclaw.ai" rel="noreferrer noopener" target="_blank">OpenClaw中文</a></p>\n',
      );
    });

    it("preserves mailto: scheme when trimming CJK from email links", () => {
      // Email followed by space+CJK — linkify recognizes the email,
      // then CJK trim should preserve the mailto: prefix.
      const html = toSanitizedMarkdownHtml("Contact test@example.com 中文说明");
      expect(html).toBe(
        '<p>Contact <a href="mailto:test@example.com" rel="noreferrer noopener" target="_blank">test@example.com</a> 中文说明</p>\n',
      );
    });
  });

  describe("link favicon placeholders", () => {
    it("emits no favicon markup unless explicitly enabled", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("[Docs](https://docs.example.com/a)"));

      expect(fragment.querySelector("img.markdown-link-favicon")).toBeNull();
    });

    it("emits an inert hostname-only placeholder for enabled web links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[Docs](https://docs.example.com/a?secret=1#fragment)", {
          linkFavicons: true,
        }),
      );

      const image = fragment.querySelector<HTMLImageElement>("img.markdown-link-favicon");
      expect(image?.dataset.linkFaviconHost).toBe("docs.example.com");
      expect(image?.hasAttribute("src")).toBe(false);
      expect(image?.alt).toBe("");
    });

    it("keeps the bundled GitHub mark and skips image-only links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[OpenClaw](https://github.com/openclaw/openclaw) [![badge](data:image/png;base64,iVBORw0KGgo=)](https://example.com)",
          { linkFavicons: true },
        ),
      );

      expect(fragment.querySelector("a.markdown-github-link")).not.toBeNull();
      expect(fragment.querySelector("a.markdown-github-link img.markdown-link-favicon")).toBeNull();
      expect(fragment.querySelectorAll("img.markdown-link-favicon")).toHaveLength(0);
    });
  });

  describe("session links", () => {
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";

    it("links structural keys only when enabled", () => {
      const disabled = htmlFragment(toSanitizedMarkdownHtml(`Open ${sessionKey}`));
      expect(disabled.querySelector("a[data-session-key]")).toBeNull();

      const enabled = htmlFragment(
        toSanitizedMarkdownHtml(`Open ${sessionKey}`, { sessionLinks: true }),
      );
      const link = enabled.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(sessionKey);
      expect(link?.textContent).toBe(sessionKey);
      expect(link?.getAttribute("role")).toBe("link");
      expect(link?.getAttribute("tabindex")).toBe("0");
      expect(link?.hasAttribute("href")).toBe(false);
    });

    it("linkifies keys in inline code", () => {
      const input = `Open \`${sessionKey}\``;
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(sessionKey);
      expect(link?.textContent).toBe(sessionKey);
    });

    it.each([
      ["an empty prefix", "agent:"],
      ["a missing rest segment", "agent:x"],
      ["an empty middle segment", "agent:x::y"],
      ["a URL query value", `https://example.test/?session=${sessionKey}`],
      ["a fenced code block", `\`\`\`text\n${sessionKey}\n\`\`\``],
    ])("does not link %s", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      expect(fragment.querySelector("a[data-session-key]")).toBeNull();
    });

    it.each([
      ["absolute href", `[Open session](${location.origin}/chat/roboclaw/d0effac9)`],
      ["bare URL", `${location.origin}/chat/roboclaw/d0effac9`],
      ["relative href", "[Open session](/chat/roboclaw/d0effac9)"],
      ["literal with a file extension", "[Open session](/chat/roboclaw/d0effac9.md)"],
      ["inline URL", `\`${location.origin}/chat/roboclaw/d0effac9\``],
      ["inline relative URL", "`/chat/roboclaw/d0effac9`"],
    ])("decorates host-local session URLs in %s", (_kind, input) => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(input, { sessionLinks: true, fileLinks: true }),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.getAttribute("href")).toContain("/chat/roboclaw/d0effac9");
      expect(link?.hasAttribute("target")).toBe(false);
      expect(link?.hasAttribute("data-file-path")).toBe(false);
      expect(link?.hasAttribute("data-session-key")).toBe(false);
      expect(fragment.querySelector("a a")).toBeNull();
    });

    it("captures the cleaned session URL with query and fragment before trailing CJK prose", () => {
      const href = `${location.origin}/chat/main/d0effac9?view=full#latest`;
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(`${href}重新解读`, { sessionLinks: true, fileLinks: true }),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
      expect(link.getAttribute("href")).toBe(href);
      expect(link.dataset.sessionHref).toBe(href);
      expect(link.textContent).toBe(href);
      expect(link.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
      expect(link.nextSibling?.textContent).toBe("重新解读");
    });

    it.each([
      "https://elsewhere.example/chat/roboclaw/d0effac9",
      "[External session](https://elsewhere.example/chat/roboclaw/d0effac9)",
      "`https://elsewhere.example/chat/roboclaw/d0effac9`",
      "[Other page](/activity)",
    ])("keeps other destinations undecorated: %s", (input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      expect(fragment.querySelector(".markdown-session-link")).toBeNull();
      expect(fragment.querySelector("[data-session-key]")).toBeNull();
      if (input.startsWith("`")) {
        expect(fragment.querySelector("a")).toBeNull();
      }
    });

    it.each([
      ["source", "src/utils/foo.ts", "file"],
      ["root session", "/chat/main/cafebabe", "session"],
      ["absolute session", `${location.origin}/chat/main/cafebabe`, "session"],
      ["relative route", "chat/main/x", "plain"],
    ])("classifies %s independently of the current chat route", (label, href, kind) => {
      const previous = location.href;
      history.replaceState(null, "", "/chat/main/d0effac9");
      try {
        const fragment = htmlFragment(
          toSanitizedMarkdownHtml(`[${label}](${href})`, { sessionLinks: true, fileLinks: true }),
        );
        const link = fragment.querySelector<HTMLAnchorElement>("a")!;
        expect(link.classList.contains("markdown-session-link")).toBe(kind === "session");
        expect(link.hasAttribute("data-session-href")).toBe(kind === "session");
        expect(link.classList.contains("markdown-file-link")).toBe(kind === "file");
        expect(link.dataset.filePath).toBe(kind === "file" ? href : undefined);
        expect(link.getAttribute("href")).toBe(kind === "file" ? null : href);
      } finally {
        history.replaceState(null, "", previous);
      }
    });

    it("keeps ordinary inline code out of session routes on a chat page", () => {
      const previous = location.href;
      history.replaceState(null, "", "/chat/main/d0effac9");
      try {
        const fragment = htmlFragment(
          toSanitizedMarkdownHtml("`README.md` `src/chat.ts` `ordinary text`", {
            sessionLinks: true,
          }),
        );
        expect(fragment.querySelector("a")).toBeNull();
        expect(fragment.querySelectorAll("code")).toHaveLength(3);
      } finally {
        history.replaceState(null, "", previous);
      }
    });

    it("keeps punctuation outside the link and rejects embedded word matches", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(`(${sessionKey}), x${sessionKey}`, { sessionLinks: true }),
      );
      const links = fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link");
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toBe(sessionKey);
      expect(fragment.textContent).toBe(`(${sessionKey}), x${sessionKey}\n`);
    });

    it("stays deterministic across streaming tail renders", () => {
      const options = { sessionLinks: true } as const;
      const first = htmlFragment(toStreamingMarkdownParts(`Open ${sessionKey}`, options).join(""));
      const extended = htmlFragment(
        toStreamingMarkdownParts(`Open ${sessionKey} and continue`, options).join(""),
      );
      expect(first.querySelector<HTMLAnchorElement>("a")?.dataset.sessionKey).toBe(sessionKey);
      expect(extended.querySelector<HTMLAnchorElement>("a")?.dataset.sessionKey).toBe(sessionKey);
    });
  });

  describe("bare url links", () => {
    it("marks autolinked URL text but not authored labels", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "https://example.com/a/very/long/path and [a label](https://example.com/a/very/long/path) and www.example.com",
        ),
      );
      expect(
        [...fragment.querySelectorAll("a")].map((link) =>
          link.classList.contains("markdown-bare-url"),
        ),
      ).toEqual([true, false, true]);
    });

    it("leaves email autolinks unmarked", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("Email me at test@example.com"));
      expect(fragment.querySelector("a.markdown-bare-url")).toBeNull();
    });
  });

  describe("github link marks", () => {
    it.each([
      ["bare pull request", "https://github.com/openclaw/openclaw/pull/3434", "#3434", "pull"],
      ["bare issue", "https://github.com/openclaw/openclaw/issues/3435", "#3435", "issue"],
      ["autolink", "<https://github.com/openclaw/openclaw/pull/3434>", "#3434", "pull"],
      [
        "bare www item",
        "https://www.github.com/openclaw/openclaw/issues/3435",
        "#3435",
        "issue",
        true,
      ],
      ["repository", "https://github.com/openclaw/openclaw", "openclaw/openclaw", undefined],
      [
        "other path",
        "https://github.com/openclaw/openclaw/actions/runs/123",
        "github.com/openclaw/openclaw/actions/runs/123",
        undefined,
      ],
      [
        "repository directory",
        "https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit",
        "openclaw/openclaw/…/test-audit",
        undefined,
      ],
      [
        "branch root",
        "https://github.com/openclaw/openclaw/tree/main",
        "github.com/openclaw/openclaw/tree/main",
        undefined,
      ],
      [
        "slash-containing branch root",
        "https://github.com/acme/project/tree/feature/link-labels",
        "acme/project/…/link-labels",
        undefined,
      ],
      [
        "labeled directory",
        "[Audit skill](https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit)",
        "Audit skill",
        undefined,
      ],
      [
        "pull shorthand",
        "[#3434](https://github.com/openclaw/openclaw/pull/3434)",
        "#3434",
        "pull",
      ],
      [
        "repository shorthand",
        "[openclaw/openclaw#3434](https://github.com/openclaw/openclaw/pull/3434)",
        "openclaw/openclaw#3434",
        "pull",
      ],
      [
        "shorthand with authored tooltip",
        '[#3434](https://github.com/openclaw/openclaw/pull/3434 "A pull request")',
        "#3434",
        "pull",
      ],
      [
        "labelled link",
        "[the fix](https://github.com/openclaw/openclaw/pull/3434)",
        "the fix",
        undefined,
      ],
      [
        "www host",
        "[the fix](https://www.github.com/openclaw/openclaw/pull/3434)",
        "the fix",
        undefined,
      ],
      [
        "http scheme",
        "[the fix](http://github.com/openclaw/openclaw/pull/3434)",
        "the fix",
        undefined,
      ],
      [
        "wrong number",
        "[#3435](https://github.com/openclaw/openclaw/pull/3434)",
        "#3435",
        undefined,
      ],
      [
        "wrong repository",
        "[other/project#3434](https://github.com/openclaw/openclaw/pull/3434)",
        "other/project#3434",
        undefined,
      ],
      [
        "padded label",
        "[ #3434 ](https://github.com/openclaw/openclaw/pull/3434)",
        " #3434 ",
        undefined,
      ],
      [
        "code-span label",
        "[`#3434`](https://github.com/openclaw/openclaw/pull/3434)",
        "#3434",
        undefined,
      ],
    ])("marks %s", (_kind, input, expectedText, expectedKind, keepsTitle = false) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.classList.contains("markdown-github-link")).toBe(true);
      expect(link?.textContent).toBe(expectedText);
      expect(link?.classList.contains("markdown-github-item")).toBe(Boolean(expectedKind));
      expect(link?.getAttribute("data-github-kind")).toBe(expectedKind ?? null);
      if (expectedKind) {
        expect(link?.getAttribute("title")).toBe(keepsTitle ? link?.getAttribute("href") : null);
        expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
        expect(link?.getAttribute("target")).toBe("_blank");
      }
    });

    it("compacts long generated item references into chips", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/3434",
        ),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.textContent).toBe("#3434");
      expect(link?.classList.contains("markdown-bare-url")).toBe(true);
      expect(link?.classList.contains("markdown-github-item")).toBe(true);
    });

    it.each([
      ["https://github.com/blader/humanizer/blob/main/SKILL.md", "SKILL.md"],
      [
        "https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit",
        "openclaw/openclaw/…/test-audit",
      ],
      [
        "https://github.com/openclaw/openclaw/tree/main/skills/test%20audit/?tab=readme#examples",
        "openclaw/openclaw/…/test audit",
      ],
    ])("preserves the destination when shortening %s", (href, label) => {
      for (const source of [href, `<${href}>`, "`" + href + "`"]) {
        for (const html of [
          toSanitizedMarkdownHtml(source),
          toStreamingMarkdownParts(source).join(""),
        ]) {
          const link = htmlFragment(html).querySelector<HTMLAnchorElement>("a");
          expect(link?.classList.contains("markdown-github-link")).toBe(true);
          expect(link?.textContent).toBe(label);
          expect(link?.getAttribute("href")).toBe(href);
          expect(link?.getAttribute("title")).toBe(href);
          expect(link?.getAttribute("target")).toBe("_blank");
          expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
        }
      }
    });

    it.each([
      ["a files-tab path", "https://github.com/openclaw/openclaw/pull/3434/files"],
      [
        "an issue comment fragment",
        "https://github.com/openclaw/openclaw/issues/3434#issuecomment-1",
      ],
      ["a review comment query", "https://github.com/openclaw/openclaw/pull/3434?tab=files"],
      ["a diff anchor", "https://github.com/openclaw/openclaw/pull/3434/files#diff-abc123"],
    ])(
      "keeps the specific destination in the chip href without a native tooltip for %s",
      (_kind, input) => {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
        const link = fragment.querySelector<HTMLAnchorElement>("a");
        expect(link?.classList.contains("markdown-github-link")).toBe(true);
        expect(link?.classList.contains("markdown-github-item")).toBe(true);
        expect(link?.textContent).toBe("#3434");
        expect(link?.getAttribute("href")).toBe(input);
        expect(link?.hasAttribute("title")).toBe(false);
      },
    );

    it.each([
      ["non-github host", "[docs](https://example.com/openclaw)"],
      ["lookalike host", "[docs](https://notgithub.com/openclaw)"],
      ["github in query", "[docs](https://example.com/?to=https://github.com/openclaw)"],
      ["subdomain host", "[pages](https://openclaw.github.io/openclaw)"],
      ["image-only link", "[![build](data:image/png;base64,x)](https://github.com/openclaw)"],
      ["image-only item", "[![build](data:image/png;base64,x)](https://github.com/o/r/pull/3434)"],
      ["lookalike item", "https://github.com.example.com/o/r/pull/3434"],
      ["non-github shorthand", "[#3434](https://example.com/o/r/pull/3434)"],
    ])("leaves %s unmarked", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
      expect(fragment.querySelector("a.markdown-github-item, a[data-github-kind]")).toBeNull();
    });

    it("leaves github urls inside fences untouched", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "```\nhttps://github.com/openclaw/openclaw\n```\n\n```\nhttps://github.com/o/r/pull/3434\n```",
        ),
      );
      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelector(".markdown-github-link")).toBeNull();
    });

    it.each([
      ["pull request", "`https://github.com/openclaw/openclaw/pull/141131`", "#141131", "pull"],
      ["issue", "` https://github.com/o/r/issues/3434 `", "#3434", "issue"],
      ["repository", "`https://github.com/openclaw/openclaw`", "openclaw/openclaw", undefined],
    ])("promotes a code span holding only a github %s url", (_kind, input, label, kind) => {
      const href = input.replaceAll("`", "").trim();
      const fragment = htmlFragment(toSanitizedMarkdownHtml(`See ${input} today`));
      expect(fragment.querySelector("code")).toBeNull();
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-link");
      expect(link?.textContent).toBe(label);
      expect(link?.getAttribute("href")).toBe(href);
      expect(link?.getAttribute("title")).toBe(kind ? null : href);
      expect(link?.classList.contains("markdown-bare-url")).toBe(true);
      expect(link?.classList.contains("markdown-github-item")).toBe(kind !== undefined);
      expect(link?.getAttribute("data-github-kind")).toBe(kind ?? null);
    });

    it.each([
      ["a non-github url", "`https://example.com/o/r/pull/3434`"],
      ["a url with trailing prose", "`https://github.com/o/r/pull/3434 see this`"],
      ["a url with one-sided padding", "`https://github.com/o/r/pull/3434 `"],
      ["a url beside a control character", "`https://github.com/o/r/pull/3434\u0007`"],
      [
        "a code span inside an authored link",
        "[`https://github.com/o/r/pull/3434`](https://example.com)",
      ],
    ])("keeps %s as code", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      expect(fragment.querySelector("code")).not.toBeNull();
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
    });

    it("keeps the hover preview target intact on marked links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[#3434](https://github.com/openclaw/openclaw/pull/3434)"),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-link");
      expect(link?.getAttribute("href")).toBe("https://github.com/openclaw/openclaw/pull/3434");
      expect(link?.getAttribute("target")).toBe("_blank");
    });
  });
});
