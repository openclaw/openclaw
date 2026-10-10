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
  });

  describe("explicit protocol links", () => {
    it("links http:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit http://github.com/openclaw");
      expect(html).toBe(
        '<p>Visit <a href="http://github.com/openclaw" class="markdown-bare-url markdown-github-link" title="http://github.com/openclaw" rel="noreferrer noopener" target="_blank">github.com/openclaw</a></p>\n',
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

    it.each([["an empty middle segment", "agent:x::y"]])("does not link %s", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      expect(fragment.querySelector("a[data-session-key]")).toBeNull();
    });

    it.each([["inline URL", `\`${location.origin}/chat/roboclaw/d0effac9\``]])(
      "decorates host-local session URLs in %s",
      (_kind, input) => {
        const fragment = htmlFragment(
          toSanitizedMarkdownHtml(input, { sessionLinks: true, fileLinks: true }),
        );
        const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
        expect(link?.getAttribute("href")).toContain("/chat/roboclaw/d0effac9");
        expect(link?.hasAttribute("target")).toBe(false);
        expect(link?.hasAttribute("data-file-path")).toBe(false);
        expect(link?.hasAttribute("data-session-key")).toBe(false);
        expect(fragment.querySelector("a a")).toBeNull();
      },
    );

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

    it.each(["`https://elsewhere.example/chat/roboclaw/d0effac9`", "[Other page](/activity)"])(
      "keeps other destinations undecorated: %s",
      (input) => {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
        expect(fragment.querySelector(".markdown-session-link")).toBeNull();
        expect(fragment.querySelector("[data-session-key]")).toBeNull();
        if (input.startsWith("`")) {
          expect(fragment.querySelector("a")).toBeNull();
        }
      },
    );

    it.each([
      ["source", "src/utils/foo.ts", "file"],
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

    it("keeps punctuation outside the link and rejects embedded word matches", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(`(${sessionKey}), x${sessionKey}`, { sessionLinks: true }),
      );
      const links = fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link");
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toBe(sessionKey);
      expect(fragment.textContent).toBe(`(${sessionKey}), x${sessionKey}\n`);
    });
  });

  describe("github link marks", () => {
    it.each([
      [
        "bare www item",
        "https://www.github.com/openclaw/openclaw/issues/3435",
        "#3435",
        "issue",
        true,
      ],
      [
        "shorthand with authored tooltip",
        '[#3434](https://github.com/openclaw/openclaw/pull/3434 "A pull request")',
        "#3434",
        "pull",
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

    it.each([
      ["https://github.com/blader/humanizer/blob/main/SKILL.md", "SKILL.md"],
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
      ["image-only item", "[![build](data:image/png;base64,x)](https://github.com/o/r/pull/3434)"],
    ])("leaves %s unmarked", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
      expect(fragment.querySelector("a.markdown-github-item, a[data-github-kind]")).toBeNull();
    });

    it.each([
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
  });
});
