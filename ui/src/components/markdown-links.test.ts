import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  navigateMarkdownSession,
} from "./markdown-session-links.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";

const repoUrl = "https://github.com/openclaw/openclaw";
const pullUrl = `${repoUrl}/pull/3434`;
const directoryUrl = `${repoUrl}/tree/main/.agents/skills/test-audit`;
const itemLabel = "openclaw/openclaw#3434";
const longRepository = "a-very-long-organization-name/a-very-long-repository-name";
const render = (input: string, options?: MarkdownRenderOptions) =>
  htmlFragment(toSanitizedMarkdownHtml(input, options));
const renderStreaming = (input: string, options?: MarkdownRenderOptions, id?: string) =>
  htmlFragment(toStreamingMarkdownParts(input, options, id).join(""));
const renderBoth = (input: string) => [render(input), renderStreaming(input)];

function onChatPage(assert: () => void) {
  const previous = location.href;
  history.replaceState(null, "", "/chat/main/d0effac9");
  try {
    assert();
  } finally {
    history.replaceState(null, "", previous);
  }
}

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
      ["Visit www.foo_bar.example.com", "www.foo_bar.example.com", "Visit "],
      ["See www.example.com!", "www.example.com", "See ", "!"],
      [
        "www.google.com/search?q=commonmark&hl;",
        "www.google.com/search?q=commonmark",
        "",
        "&amp;hl;",
      ],
      ['"www.example.com"', "www.example.com", '"', '"'],
      [
        'www.example.com/path"with"quotes',
        'www.example.com/path"with"quotes',
        "",
        "",
        "www.example.com/path%22with%22quotes",
      ],
      ["(see www.example.com/foo(bar))", "www.example.com/foo(bar)", "(see ", ")"],
      ["Visit www.example.com/<token> here", "www.example.com/", "Visit ", "&lt;token&gt; here"],
      ["www.example.com重新解读", "www.example.com", "", "重新解读"],
    ])("preserves URL boundaries and encoding in %s", expectWwwLink);

    it.each(["Visit www.ünich.de", "Check README.md and config.json", "Check 127.0.0.1:8080"])(
      "leaves non-URLs unlinked: %s",
      (input) => {
        expect(toSanitizedMarkdownHtml(input)).toBe(`<p>${input}</p>\n`);
      },
    );
  });

  describe("explicit protocol links", () => {
    it("keeps preparation status metadata outside its PR link", () => {
      const input =
        `PR preparation result: {"status":"prepared","url":"${pullUrl}","headCommit":"abc123","headChanged":false,"review":{"mode":"local","base":"def456"}}\n` +
        "Continue the original task in this conversation. Do not repeat a completed operation.";
      const fragment = render(input);
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.getAttribute("href")).toBe(pullUrl);
      expect(link?.textContent).toBe(itemLabel);
      expect(fragment.textContent).toBe(input.replace(pullUrl, itemLabel) + "\n");
    });

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

  it("preserves adjacent quoted links and authored or encoded URL content", () => {
    const encoded = "https://example.com/a%22b?q=%22value%22";
    const plain = "http://example.com/path_(part)?a=1&b=2#section";
    const input = `Links: {"first":"${encoded}","second":"${plain}"} [authored](${encoded})`;
    const fragment = render(input);
    expect(Array.from(fragment.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual(
      [encoded, plain, encoded],
    );
    expect(fragment.textContent).toBe(
      `Links: {"first":"https://example.com/a"b?q="value"","second":"${plain}"} authored\n`,
    );
  });

  describe("link favicon placeholders", () => {
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
      expect(fragment.querySelectorAll("img.markdown-link-favicon")).toHaveLength(0);
    });
  });

  describe("session links", () => {
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";

    it("linkifies keys in streamed inline code", () => {
      const input = `Open \`${sessionKey}\``;
      const fragment = renderStreaming(input, { sessionLinks: true });
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
      const fragment = render(input, { sessionLinks: true });
      expect(fragment.querySelector("a[data-session-key]")).toBeNull();
    });

    it.each([
      ["absolute href", `[Open session](${location.origin}/chat/roboclaw/d0effac9)`],
      ["literal with a file extension", "[Open session](/chat/roboclaw/d0effac9.md)"],
    ])("decorates host-local session URLs in %s", (_kind, input) => {
      const fragment = render(input, { sessionLinks: true, fileLinks: true });
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.getAttribute("href")).toContain("/chat/roboclaw/d0effac9");
      expect(link?.hasAttribute("target")).toBe(false);
      expect(link?.hasAttribute("data-file-path")).toBe(false);
      expect(link?.hasAttribute("data-session-key")).toBe(false);
      expect(fragment.querySelector("a a")).toBeNull();
    });

    it.each([
      ["source", "src/utils/foo.ts", "file"],
      ["root session", "/chat/main/cafebabe", "session"],
      ["absolute session", `${location.origin}/chat/main/cafebabe`, "session"],
      ["relative route", "chat/main/x", "plain"],
      ["other application page", "/activity", "plain"],
    ])("classifies %s independently of the current chat route", (label, href, kind) => {
      onChatPage(() => {
        const fragment = render(`[${label}](${href})`, { sessionLinks: true, fileLinks: true });
        const link = fragment.querySelector<HTMLAnchorElement>("a")!;
        expect(link.classList.contains("markdown-session-link")).toBe(kind === "session");
        expect(link.hasAttribute("data-session-href")).toBe(kind === "session");
        expect(link.hasAttribute("data-session-key")).toBe(false);
        expect(link.classList.contains("markdown-file-link")).toBe(kind === "file");
        expect(link.dataset.filePath).toBe(kind === "file" ? href : undefined);
        expect(link.getAttribute("href")).toBe(kind === "file" ? null : href);
      });
    });

    it("keeps ordinary inline code out of session routes on a chat page", () => {
      onChatPage(() => {
        const fragment = render("`README.md` `src/chat.ts` `ordinary text`", {
          sessionLinks: true,
        });
        expect(fragment.querySelector("a")).toBeNull();
        expect(fragment.querySelectorAll("code")).toHaveLength(3);
      });
    });

    it("links enabled structural keys with punctuation and rejects embedded word matches", () => {
      const source = `(${sessionKey}), x${sessionKey}`;
      expect(render(source).querySelector("a[data-session-key]")).toBeNull();
      const fragment = render(source, { sessionLinks: true });
      const links = fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link");
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        textContent: sessionKey,
        dataset: { sessionKey },
      });
      expect(links[0]?.getAttribute("role")).toBe("link");
      expect(links[0]?.getAttribute("tabindex")).toBe("0");
      expect(links[0]?.hasAttribute("href")).toBe(false);
      expect(fragment.textContent).toBe(`(${sessionKey}), x${sessionKey}\n`);
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
      [`[Audit skill](${directoryUrl})`, "Audit skill"],
      [`[#3434](${pullUrl})`, itemLabel, "pull", false, pullUrl],
      [`[${itemLabel}](${pullUrl})`, itemLabel, "pull"],
      [`[#3434](${pullUrl} "A pull request")`, itemLabel, "pull"],
      [`[the fix](${pullUrl})`, "the fix"],
      [`[other/project#3434](${pullUrl})`, "other/project#3434"],
      [`[\`#3434\`](${pullUrl})`, "#3434"],
      [`https://github.com/${longRepository}/issues/3434`, `${longRepository}#3434`, "issue"],
      [
        `${repoUrl}/issues/3434#issuecomment-1`,
        itemLabel,
        "issue",
        false,
        `${repoUrl}/issues/3434#issuecomment-1`,
      ],
    ] satisfies Array<[string, string, string?, boolean?, string?]>)(
      "marks %s",
      (input, expectedText, expectedKind?: string, keepsTitle?: boolean, expectedHref?: string) => {
        const fragment = render(input);
        const link = fragment.querySelector<HTMLAnchorElement>("a");
        expect(link?.classList.contains("markdown-github-link")).toBe(true);
        expect(link?.textContent).toBe(expectedText);
        expect(link?.classList.contains("markdown-github-item")).toBe(Boolean(expectedKind));
        expect(link?.getAttribute("data-github-kind")).toBe(expectedKind ?? null);
        if (input.startsWith("https://github.com/")) {
          expect(link?.classList.contains("markdown-bare-url")).toBe(true);
        }
        if (expectedHref) {
          expect(link?.getAttribute("href")).toBe(expectedHref);
        }
        if (expectedKind) {
          expect(link?.getAttribute("title")).toBe(keepsTitle ? link?.getAttribute("href") : null);
          expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
          expect(link?.getAttribute("target")).toBe("_blank");
        }
      },
    );

    it.each([
      ["https://github.com/blader/humanizer/blob/main/SKILL.md", "SKILL.md"],
      [
        "https://github.com/openclaw/openclaw/tree/main/skills/test%20audit/?tab=readme#examples",
        "openclaw/openclaw/…/test audit",
      ],
    ])("preserves the destination when shortening %s", (href, label) => {
      for (const source of [href, `<${href}>`, "`" + href + "`"]) {
        for (const fragment of renderBoth(source)) {
          const link = fragment.querySelector<HTMLAnchorElement>("a");
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
      ["github in query", "[docs](https://example.com/?to=https://github.com/openclaw)"],
      ["image-only item", "[![build](data:image/png;base64,x)](https://github.com/o/r/pull/3434)"],
      ["lookalike item", "https://github.com.example.com/o/r/pull/3434"],
    ])("leaves %s unmarked", (_kind, input) => {
      const fragment = render(input);
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
      expect(fragment.querySelector("a.markdown-github-item, a[data-github-kind]")).toBeNull();
    });

    it.each([
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
      ["a url with one-sided padding", "`https://github.com/o/r/pull/3434 `"],
      ["a url beside a control character", "`https://github.com/o/r/pull/3434\u0007`"],
      [
        "a code span inside an authored link",
        "[`https://github.com/o/r/pull/3434`](https://example.com)",
      ],
    ])("keeps %s as code", (_kind, input) => {
      const fragment = render(input);
      expect(fragment.querySelector("code")).not.toBeNull();
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
    });
  });
});

describe("github item references", () => {
  it.each([
    ["openclaw/clawsweeper#1576", "issues", "1576"],
    ["PR openclaw/clawsweeper#42", "pull", "42"],
    ["openclaw/clawsweeper PR #42", "pull", "42"],
    ["pull **request** *openclaw/clawsweeper#42*", "pull", "42"],
    ["issue openclaw/clawsweeper#42.", "issues", "42"],
  ])("renders an explicit repository and item kind in %s", (source, path, number) => {
    for (const fragment of renderBoth(source)) {
      const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
      expect(anchor?.href).toBe("https://github.com/openclaw/clawsweeper/" + path + "/" + number);
      expect(anchor?.textContent).toBe("openclaw/clawsweeper#" + number);
      expect(anchor?.dataset.githubKind).toBe(path === "pull" ? "pull" : "issue");
      expect(anchor?.classList.contains("markdown-github-link")).toBe(true);
    }
  });

  it.each([
    "PR #126",
    "#141270",
    "PR #0123",
    "issue acme/research#12345678901",
    "acme/research#126.txt",
    "word#141270",
    "../..#141270",
    "re**PR** #42",
    "PR " + String.fromCharCode(96) + "acme/research#126" + String.fromCharCode(96),
    "# PR acme/research#126",
    "[PR #126](https://example.test)",
  ])("does not invent a destination for %s", (source) => {
    for (const fragment of renderBoth(source)) {
      expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
      expect(fragment.querySelector("a a")).toBeNull();
    }
  });

  it("keeps bare references plain when streamed links add another repository", () => {
    const source = "PR #126. PR acme/research#126.";
    for (const suffix of ["", " https://github.com/other/project/pull/126"]) {
      for (const fragment of [
        render(source + suffix),
        renderStreaming(source + suffix, {}, "github-explicit-stream"),
      ]) {
        const anchors = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")];
        expect(anchors[0]?.href).toBe("https://github.com/acme/research/pull/126");
        expect(anchors).toHaveLength(suffix ? 2 : 1);
        expect(fragment.textContent).toContain("PR #126.");
      }
    }
  });

  it("preserves explicit destinations, ordinary links, fragments, and independent repositories", () => {
    const source =
      "[PR #126](https://github.com/acme/research/pull/126#discussion_r123) and " +
      "https://github.com/other/project/issues/126, PR acme/third#126, [guide](https://example.test/guide).";
    for (const fragment of renderBoth(source)) {
      expect([...fragment.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.href)).toEqual([
        "https://github.com/acme/research/pull/126#discussion_r123",
        "https://github.com/other/project/issues/126",
        "https://github.com/acme/third/pull/126",
        "https://example.test/guide",
      ]);
      expect(fragment.querySelector("a")?.textContent).toBe("PR #126");
    }
  });
});

describe("selected human mention rendering", () => {
  function selected(
    source: string,
    label: string,
    profileId = "profile-ada",
    start = source.indexOf(label),
  ) {
    return { profileId, start, end: start + label.length };
  }
  const person = (fragment: HTMLElement) => fragment.querySelector("openclaw-person-reference");

  function renderMentions(
    source: string,
    humanMentions: readonly ReturnType<typeof selected>[] = [],
  ) {
    return render(source, { humanMentions });
  }

  describe("explicit human mention Markdown", () => {
    it("normalizes lines without changing the selected Unicode occurrence", () => {
      const source = "🦞 **Hello**\r\n@Ada Lovelace cc @Ada Lovelace";
      const label = "@Ada Lovelace";
      const fragment = renderMentions(source, [
        selected(source, label, "canonical-person", source.lastIndexOf(label)),
      ]);
      const references = fragment.querySelectorAll("openclaw-person-reference");
      expect(references).toHaveLength(1);
      expect(references[0]?.getAttribute("profile-id")).toBe("canonical-person");
      expect(references[0]?.getAttribute("label")).toBe(label);
      expect(fragment.textContent?.trim()).toBe("🦞 Hello\n@Ada Lovelace cc @Ada Lovelace");
      expect(fragment.querySelector("strong")?.textContent).toBe("Hello");
    });

    it.each([
      ['@Ada_One & <img src=x onerror="alert(1)">', "Hello ", ""],
      ["@Ada `One`", "Hello ", ""],
      ["@Ada", "[Hello ", "]"],
    ])("keeps selected labels literal: %s", (label, prefix, suffix) => {
      const source = prefix + label + suffix;
      const fragment = renderMentions(source, [selected(source, label)]);
      expect(person(fragment)?.textContent).toBe(label);
      expect(fragment.querySelector("img,script,em,code,[onerror]")).toBeNull();
      expect(fragment.textContent?.trim()).toBe(source);
    });

    it.each([
      "`@Ada`",
      "```text\n@Ada\n```",
      "    @Ada",
      "[@Ada](https://example.test)",
      "[link](https://example.test/@Ada)",
      "https://example.test/@Ada",
      "https://@Ada",
      "/tmp/@Ada.md",
      "![@Ada](https://example.test/image.png)",
      '<span title="@Ada">example</span>',
    ])("excludes code, links and attributes: %s", (source) => {
      const rendered = toSanitizedMarkdownHtml(source, {
        fileLinks: true,
        humanMentions: [selected(source, "@Ada")],
      });
      const fragment = htmlFragment(rendered);
      expect(person(fragment)).toBeNull();
      expect(rendered).not.toContain("openclawhumanmention");
      expect(rendered).toContain("@Ada");
    });

    it.each([
      [
        "Before [@Ada $&](https://example.test) after",
        0,
        ["@Ada $&"],
        "https://example.test",
        "@Ada $&",
        "Before @Ada $& after",
      ],
      ["[@Ada]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "@Ada"],
      ["[@Ada][]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "@Ada"],
      ["[label][@Ada]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "label"],
      ["[@Ada]\n\n[@Ada]: /person\n[@Ada]: /other", 1, ["@Ada"], "/person", "@Ada"],
      ["[@Ada @Bob][]\n\n[@Ada @Bob]: /people", 0, ["@Ada", "@Bob"], "/people", "@Ada @Bob"],
    ] as const)(
      "restores link labels: %s",
      (source, occurrence, labels, href, text, content?: string) => {
        const mentions = labels.map((label) =>
          selected(
            source,
            label,
            "profile-" + label,
            occurrence ? source.indexOf(label, source.indexOf(label) + 1) : source.indexOf(label),
          ),
        );
        const rendered = toSanitizedMarkdownHtml(source, { humanMentions: mentions });
        const fragment = htmlFragment(rendered);
        expect(rendered).not.toContain("openclawhumanmention");
        if (content !== undefined) {
          expect(fragment.textContent?.trim()).toBe(content);
        }
        expect(fragment.querySelector("a")?.getAttribute("href")).toBe(href);
        expect(fragment.querySelector("a")?.textContent).toBe(text);
        expect(person(fragment)).toBeNull();
        expect(fragment.textContent).not.toContain("openclawhumanmention");
      },
    );

    it("preserves reference-style images", () => {
      const source = "![@Ada][]\n\n[@Ada]: https://example.test/person.png";
      expect(toSanitizedMarkdownHtml(source, { humanMentions: [selected(source, "@Ada")] })).toBe(
        toSanitizedMarkdownHtml(source),
      );
    });

    it.each([
      "[@Ada]\n\n[OPENCLAWHUMANMENTION0X0END]: /literal\n\n@Ada",
      "[OPENCLAWHUMANMENTION0X0END]\n\n[@Ada]: /person\n\n@Ada",
    ])("does not alias authored references to generated markers: %s", (source) => {
      const fragment = renderMentions(source, [
        selected(source, "@Ada", "profile-ada", source.lastIndexOf("@Ada")),
      ]);
      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelectorAll("openclaw-person-reference")).toHaveLength(1);
    });

    it.each([
      [
        '@Ada <openclaw-person-reference profile-id="secret" label="@Ada">@Ada</openclaw-person-reference>',
        [],
      ],
      ["@Ada", [selected("@Ada", "@Ada", "one"), selected("@Ada", "@Ada", "two")]],
    ] as const)("rejects untrusted or overlapping identity: %s", (source, mentions) => {
      const fragment = renderMentions(source, mentions);
      expect(person(fragment)).toBeNull();
      expect(fragment.textContent?.trim()).toBe(source);
    });

    it("keys the cache by selected identity or its absence", () => {
      for (const id of ["first", "second", null, "first"]) {
        const source = "@Same Name";
        const fragment = renderMentions(source, id ? [selected(source, source, id)] : []);
        expect(person(fragment)?.getAttribute("profile-id") ?? null).toBe(id);
      }
    });

    it("restores placeholders in oversized fallback and streaming", () => {
      const source = "@Ada " + "long text ".repeat(4500);
      const options = { humanMentions: [selected(source, "@Ada")] };
      const fallback = htmlFragment(toSanitizedMarkdownHtml(source, options));
      expect(fallback.textContent).toBe(source);
      expect(person(fallback)).toBeNull();
      const [stable, tail] = toStreamingMarkdownParts("@Ada", options);
      expect(person(htmlFragment(stable))?.textContent).toBe("@Ada");
      expect(tail).toBe("");
    });
  });
});

describe("session navigation", () => {
  type SessionRow = { key: string; agentId: string; displayName: string };
  function makeContext(rows?: SessionRow[], navigate = vi.fn()) {
    return {
      basePath: "",
      sessions: { state: rows ? { result: { sessions: rows } } : {} },
      agents: { state: {} },
      agentSelection: { state: {} },
      gateway: { snapshot: {} },
      navigate,
    } as unknown as ApplicationContext;
  }

  it.each(["", "?view=full#latest"])(
    "refreshes a cleaned session title with suffix %j",
    async (suffix) => {
      const sessionKey = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
      const pathname = "/chat/main/d0effac9";
      const href = `${location.origin}${pathname}${suffix}`;
      const host = render(`${href}重新解读`, { sessionLinks: true });
      const anchor = host.querySelector<HTMLAnchorElement>("a")!;
      const titler = new SessionLinkTitler();
      titler.context = makeContext([{ key: sessionKey, agentId: "main", displayName: "Research" }]);
      titler.register(anchor, document.createElement("span"));
      await titler.decorate(anchor);
      titler.refresh();
      expect(anchor).toMatchObject({
        textContent: "Research",
        dataset: { sessionKey, sessionHref: href },
      });
      expect(anchor.getAttribute("href")).toBe(`${pathname}${suffix}`);
      expect(anchor.nextSibling?.textContent).toBe("重新解读");
    },
  );

  it("navigates through the canonical chat session route", () => {
    const navigate = vi.fn();
    navigateMarkdownSession(makeContext(undefined, navigate), {
      sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
      agentId: "roboclaw",
    });
    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/roboclaw/dashboard/2139bddb-3211-4641-b993-10f619f124e6",
      search: "?__openclawSessionFacePreference=1",
    });
  });
  it.each([
    ["click", "a"],
    [" ", "a"],
    ["Enter", "code"],
  ])("routes public-origin %s on %s before hovercard init", (action, tag) => {
    const runtimeConfig = { gateway: { publicOrigin: "https://CHAT.example:443/" } };
    const context = {
      basePath: "/control",
      runtimeConfig: { state: { configSnapshot: { runtimeConfig } } },
    };
    const provider = document.createElement("openclaw-session-progress-hovercard-provider");
    Object.assign(provider, { context });
    const anchor = document.createElement(tag);
    const href = "https://chat.example/control/chat/roboclaw/d0effac9?view=full#latest";
    anchor.setAttribute(tag === "a" ? "href" : "data-session-href", href);
    provider.append(anchor);
    const resolve = vi.fn((event: Event) => {
      if (event instanceof MouseEvent) {
        event.preventDefault();
      }
      return event instanceof KeyboardEvent
        ? markdownSessionLinkFromKeyboardEvent(event)
        : markdownSessionLinkFromEvent(event);
    });
    anchor.addEventListener(action === "click" ? "click" : "keydown", resolve);
    const event =
      action === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect(resolve).toHaveReturnedWith({
      namespace: "chat",
      pathname: "/control/chat/roboclaw/d0effac9",
      search: "?view=full",
      hash: "#latest",
    });
    expect(anchor.dataset.sessionKey).toBeUndefined();
    expect(anchor.getAttribute("href") ?? anchor.dataset.sessionHref).toBe(href);
    if (action !== "click") {
      expect(event.defaultPrevented).toBe(true);
    }
  });
});
