import { describe, expect, it } from "vitest";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

const repoUrl = "https://github.com/openclaw/openclaw";
const pullUrl = `${repoUrl}/pull/3434`;
const directoryUrl = `${repoUrl}/tree/main/.agents/skills/test-audit`;
const itemLabel = "openclaw/openclaw#3434";
const render = (input: string, options?: MarkdownRenderOptions) =>
  htmlFragment(toSanitizedMarkdownHtml(input, options));

function expectWwwLink(input: string, label: string, prefix = "", suffix = "", path = label) {
  expect(toSanitizedMarkdownHtml(input)).toBe(
    `<p>${prefix}<a href="http://${path}" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">${label}</a>${suffix}</p>\n`,
  );
}

describe("toSanitizedMarkdownHtml links", () => {
  describe("www autolinks", () => {
    it.each([
      ["See www.example.com/path?a=1#section", "www.example.com/path?a=1#section", "See "],
      ["Visit www.localhost:3000/path for dev", "www.localhost:3000/path", "Visit ", " for dev"],
      ["Visit www.münich.de", "www.münich.de", "Visit ", "", "www.xn--mnich-kva.de"],
      ["Visit www.café.example", "www.café.example", "Visit ", "", "www.xn--caf-dma.example"],
      ["Visit www.foo_bar.example.com", "www.foo_bar.example.com", "Visit "],
      ["Check www.example.com/help.", "www.example.com/help", "Check ", "."],
      ["See www.example.com!", "www.example.com", "See ", "!"],
      [
        "www.google.com/search?q=commonmark&hl;",
        "www.google.com/search?q=commonmark",
        "",
        "&amp;hl;",
      ],
      ["www.example.com/path&amp;", "www.example.com/path", "", "&amp;"],
      ['"www.example.com"', "www.example.com", '"', '"'],
      [
        'www.example.com/path"with"quotes',
        'www.example.com/path"with"quotes',
        "",
        "",
        "www.example.com/path%22with%22quotes",
      ],
      ['www.example.com/path"', "www.example.com/path", "", '"'],
      ["(see www.example.com/foo(bar))", "www.example.com/foo(bar)", "(see ", ")"],
      ["Visit www.example.com/path<test", "www.example.com/path", "Visit ", "&lt;test"],
      ["Visit www.example.com/<token> here", "www.example.com/", "Visit ", "&lt;token&gt; here"],
      ["www.example.com重新解读", "www.example.com", "", "重新解读"],
      ["www.example.comテスト", "www.example.com", "", "テスト"],
    ])("preserves URL boundaries and encoding in %s", expectWwwLink);

    it.each([
      "Visit www.ünich.de",
      "Visit www.ñoño.com",
      "Visit google.com today",
      "Check README.md and config.json",
      "Check 127.0.0.1:8080",
    ])("leaves non-URLs unlinked: %s", (input) => {
      expect(toSanitizedMarkdownHtml(input)).toBe(`<p>${input}</p>\n`);
    });
  });

  describe("explicit protocol links", () => {
    it.each([
      [
        "Visit http://github.com/openclaw",
        'Visit <a href="http://github.com/openclaw" class="markdown-bare-url markdown-github-link" title="http://github.com/openclaw"',
        "github.com/openclaw</a>",
      ],
      [
        "https://example.com/path重新解读",
        '<a href="https://example.com/path" class="markdown-bare-url"',
        "https://example.com/path</a>重新解读",
      ],
      [
        "https://example.com/你/test",
        '<a href="https://example.com/%E4%BD%A0/test" class="markdown-bare-url"',
        "https://example.com/你/test</a>",
      ],
      [
        "https://example.com/path/%E4%BD%A0%E5%A5%BD",
        '<a href="https://example.com/path/" class="markdown-bare-url"',
        "https://example.com/path/</a>你好",
      ],
      [
        "[OpenClaw中文](https://docs.openclaw.ai)",
        '<a href="https://docs.openclaw.ai"',
        "OpenClaw中文</a>",
      ],
      [
        "Contact test@example.com 中文说明",
        'Contact <a href="mailto:test@example.com"',
        "test@example.com</a> 中文说明",
      ],
    ])("preserves protocol and CJK boundaries in %s", (input, opening, ending) => {
      expect(toSanitizedMarkdownHtml(input)).toBe(
        `<p>${opening} rel="noreferrer noopener" target="_blank">${ending}</p>\n`,
      );
    });
  });

  describe("link favicon placeholders", () => {
    it("emits no favicon markup unless explicitly enabled", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("[Docs](https://docs.example.com/a)"));

      expect(fragment.querySelector("img.markdown-link-favicon")).toBeNull();
    });

    it("emits an inert hostname-only placeholder for enabled web links", () => {
      const fragment = render("[Docs](https://docs.example.com/a?secret=1#fragment)", {
        linkFavicons: true,
      });

      const image = fragment.querySelector<HTMLImageElement>("img.markdown-link-favicon");
      expect(image?.dataset.linkFaviconHost).toBe("docs.example.com");
      expect(image?.hasAttribute("src")).toBe(false);
      expect(image?.alt).toBe("");
    });

    it("keeps the bundled GitHub mark and skips image-only links", () => {
      const fragment = render(
        "[OpenClaw](https://github.com/openclaw/openclaw) [![badge](data:image/png;base64,iVBORw0KGgo=)](https://example.com)",
        { linkFavicons: true },
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
        const fragment = render(`[${label}](${href})`, { sessionLinks: true, fileLinks: true });
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
      const fragment = render(`(${sessionKey}), x${sessionKey}`, { sessionLinks: true });
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
      [pullUrl, itemLabel, "pull"],
      [`${repoUrl}/issues/3435`, "openclaw/openclaw#3435", "issue"],
      [`<${pullUrl}>`, itemLabel, "pull"],
      [
        "https://www.github.com/openclaw/openclaw/issues/3435",
        "openclaw/openclaw#3435",
        "issue",
        true,
      ],
      [repoUrl, "openclaw/openclaw"],
      [`${repoUrl}/actions/runs/123`, "github.com/openclaw/openclaw/actions/runs/123"],
      [directoryUrl, "openclaw/openclaw/…/test-audit"],
      [`${repoUrl}/tree/main`, "github.com/openclaw/openclaw/tree/main"],
      ["https://github.com/acme/project/tree/feature/link-labels", "acme/project/…/link-labels"],
      [`[Audit skill](${directoryUrl})`, "Audit skill"],
      [`[#3434](${pullUrl})`, itemLabel, "pull", false, pullUrl],
      [`[${itemLabel}](${pullUrl})`, itemLabel, "pull"],
      [`[#3434](${pullUrl} "A pull request")`, itemLabel, "pull"],
      [`[the fix](${pullUrl})`, "the fix"],
      ["[the fix](https://www.github.com/openclaw/openclaw/pull/3434)", "the fix"],
      ["[the fix](http://github.com/openclaw/openclaw/pull/3434)", "the fix"],
      [`[#3435](${pullUrl})`, "#3435"],
      [`[other/project#3434](${pullUrl})`, "other/project#3434"],
      [`[ #3434 ](${pullUrl})`, " #3434 "],
      [`[\`#3434\`](${pullUrl})`, "#3434"],
    ])("marks %s", (input, expectedText, expectedKind, keepsTitle, expectedHref) => {
      const fragment = render(input);
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.classList.contains("markdown-github-link")).toBe(true);
      expect(link?.textContent).toBe(expectedText);
      expect(link?.classList.contains("markdown-github-item")).toBe(Boolean(expectedKind));
      expect(link?.getAttribute("data-github-kind")).toBe(expectedKind ?? null);
      if (expectedHref) {
        expect(link?.getAttribute("href")).toBe(expectedHref);
      }
      if (expectedKind) {
        expect(link?.getAttribute("title")).toBe(keepsTitle ? link?.getAttribute("href") : null);
        expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
        expect(link?.getAttribute("target")).toBe("_blank");
      }
    });

    it("keeps the full repository in long generated item chips", () => {
      const fragment = render(
        "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/3434",
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.textContent).toBe(
        "a-very-long-organization-name/a-very-long-repository-name#3434",
      );
      expect(link?.classList.contains("markdown-bare-url")).toBe(true);
      expect(link?.classList.contains("markdown-github-item")).toBe(true);
    });

    it.each([
      ["https://github.com/blader/humanizer/blob/main/SKILL.md", "SKILL.md"],
      [directoryUrl, "openclaw/openclaw/…/test-audit"],
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
      `${pullUrl}/files`,
      `${repoUrl}/issues/3434#issuecomment-1`,
      `${pullUrl}?tab=files`,
      `${pullUrl}/files#diff-abc123`,
    ])(
      "keeps the specific destination in the chip href without a native tooltip for %s",
      (input) => {
        const fragment = render(input);
        const link = fragment.querySelector<HTMLAnchorElement>("a");
        expect(link?.classList.contains("markdown-github-link")).toBe(true);
        expect(link?.classList.contains("markdown-github-item")).toBe(true);
        expect(link?.textContent).toBe("openclaw/openclaw#3434");
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
      const fragment = render(input);
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
      ["pull request", `\`${repoUrl}/pull/141131\``, "openclaw/openclaw#141131", "pull"],
      ["issue", "` https://github.com/o/r/issues/3434 `", "o/r#3434", "issue"],
      ["repository", `\`${repoUrl}\``, "openclaw/openclaw", undefined],
    ])("promotes a code span holding only a github %s url", (_kind, input, label, kind) => {
      const href = input.replaceAll("`", "").trim();
      const fragment = render(`See ${input} today`);
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
  });
});
