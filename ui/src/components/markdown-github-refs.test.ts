import { describe, expect, it } from "vitest";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

describe("github item references", () => {
  const githubRepo = { owner: "openclaw", repo: "openclaw" };

  const githubRepositories = [
    { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] },
    { owner: "other", repo: "release-tools", aliases: ["Release.Tools", "Release Tools"] },
  ];
  function render(source: string, options: MarkdownRenderOptions = { githubRepo }) {
    return htmlFragment(toSanitizedMarkdownHtml(source, options));
  }

  it.each([
    ["Original ClawSweeper PR **#1558 merged**", "openclaw/clawsweeper/pull/1558"],
    ["Release.Tools issue **#42**", "other/release-tools/issues/42"],
    ["release-tools PR #42", "other/release-tools/pull/42"],
  ])("resolves the named repository in %s", (source, target) => {
    const options = { githubRepo, githubRepositories };
    for (const rendered of [
      toSanitizedMarkdownHtml(source, options),
      toStreamingMarkdownParts(source, options).join(""),
    ]) {
      expect(htmlFragment(rendered).querySelector("a")?.getAttribute("href")).toBe(
        "https://github.com/" + target,
      );
    }
  });

  it("keeps local qualifiers independent for same-number references in one reply", () => {
    const input = "ClawSweeper PR #1576; Release.Tools PR #1576; PR #1576.";
    const fragment = render(input, { githubRepo, githubRepositories });
    expect([...fragment.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/openclaw/clawsweeper/pull/1576",
      "https://github.com/other/release-tools/pull/1576",
      "https://github.com/openclaw/openclaw/pull/1576",
    ]);
    expect(fragment.textContent?.trim()).toBe(input);
  });

  it.each([
    "ClawSweeper PR **#1576 opened**",
    "UnknownProject PR #1576",
    'repository "Unknown Project" PR #1576',
  ])("does not bind an unresolved named reference to the checkout: %s", (source) => {
    for (const rendered of [
      toSanitizedMarkdownHtml(source, { githubRepo }),
      toStreamingMarkdownParts(source, { githubRepo }).join(""),
    ]) {
      expect(htmlFragment(rendered).querySelector("a")).toBeNull();
    }
  });

  it.each([
    ["original tools", "tools"],
    ["follow-up CLAWSWEEPER", "clawsweeper"],
  ])("does not reinterpret ordinary prose before the known alias in %s", (prefix, repo) => {
    const options = {
      githubRepo,
      githubRepositories: [
        { owner: "acme", repo: "tools", aliases: ["Tools"] },
        { owner: "acme", repo: "clawsweeper", aliases: ["ClawSweeper"] },
      ],
    };
    for (const html of [
      toSanitizedMarkdownHtml(prefix + " PR #42", options),
      toStreamingMarkdownParts(prefix + " PR #42", options).join(""),
    ]) {
      expect(htmlFragment(html).querySelector("a")?.getAttribute("href")).toBe(
        "https://github.com/acme/" + repo + "/pull/42",
      );
    }
  });

  it("prefers a known unresolved full alias to its resolved suffix", () => {
    const options = {
      githubRepo,
      githubRepositories: [
        { owner: "acme", repo: "tools", aliases: ["Tools"] },
        { aliases: ["Unknown Tools"] },
      ],
    };
    expect(render("Original Unknown Tools PR #42", options).querySelector("a")).toBeNull();
  });

  it("does not pick a repository when an alias is ambiguous", () => {
    const options = {
      githubRepo,
      githubRepositories: [
        ...githubRepositories,
        { owner: "fork", repo: "clawsweeper", aliases: ["ClawSweeper"] },
      ],
    };
    expect(render("ClawSweeper PR #1576", options).querySelector("a")).toBeNull();
  });

  it.each([
    ["openclaw/clawsweeper#1576", "issues"],
    ["PR openclaw/clawsweeper#42", "pull"],
    ["openclaw/clawsweeper PR #42", "pull"],
  ])("resolves explicit owner/repo without a checkout: %s", (source, kind) => {
    const fragment = render(source, {});
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/clawsweeper/" +
        kind +
        (source.includes("1576") ? "/1576" : "/42"),
    );
    expect(fragment.textContent?.trim()).toBe(source);
  });

  it.each([
    ["(CLAWsweeper) PR #42", "clawsweeper"],
    ['"ClawSweeper": PR #42', "clawsweeper"],
    ["Original **ClawSweeper _PR_** **#42 merged**", "clawsweeper"],
    ["Finished. Follow-up PR #42", "openclaw"],
  ])("recognizes exact aliases but preserves ordinary prose: %s", (source, repo) => {
    const rendered = render(source, { githubRepo, githubRepositories });
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/" + repo + "/pull/42",
    );
  });

  it.each([
    [{ aliases: ["ClawSweeper"] }],
    [{ owner: "fork", repo: "openclaw", aliases: ["OpenClaw"] }],
  ])("does not select the checkout to break a known alias collision", (other) => {
    const options = { githubRepo, githubRepositories: [...githubRepositories, other] };
    const source = other.aliases[0] + " PR #1576";
    expect(render(source, options).querySelector("a")).toBeNull();
  });

  it("deduplicates same-coordinate aliases and resolves without checkout context", () => {
    const options = {
      githubRepositories: [
        ...githubRepositories,
        { owner: "OPENCLAW", repo: "CLAWSWEEPER", aliases: ["clawsweeper"] },
      ],
    };
    expect(render("ClawSweeper PR #42", options).querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/clawsweeper/pull/42",
    );
  });

  it.each(["Unknown.Project PR #1576", "project unknown PR #1576", "repo: unknown PR #1576"])(
    "leaves syntactically qualified unknown repositories unlinked: %s",
    (source) => {
      expect(render(source).querySelector("a")).toBeNull();
    },
  );

  it("does not match aliases inside larger identifiers", () => {
    const options = {
      githubRepo,
      githubRepositories: [{ owner: "other", repo: "project", aliases: ["Claw"] }],
    };
    expect(render("OpenClaw PR #42", options).querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/42",
    );
  });

  it.each([
    "project Unknown Tools PR #42",
    "(“Unknown Tools”) PR #42",
    "\"Unknown 'Legacy' Tools\" PR #42",
  ])("does not select a known suffix inside an explicit complete name: %s", (source) => {
    const options = {
      githubRepo,
      githubRepositories: [{ owner: "acme", repo: "tools", aliases: ["Tools"] }],
    };
    expect(render(source, options).querySelector("a")).toBeNull();
  });

  it("prefers complete registered names over ordinary reference prefixes", () => {
    const options = {
      githubRepo,
      githubRepositories: [
        { owner: "acme", repo: "tools", aliases: ["Tools"] },
        { owner: "other", repo: "original-tools", aliases: ["Original Tools"] },
      ],
    };
    expect(render("Original Tools PR #42", options).querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/other/original-tools/pull/42",
    );
  });

  it("matches an entire paired-quote alias containing apostrophes", () => {
    const quotedRepositories = [{ owner: "acme", repo: "tools", aliases: ["Alice's Tools"] }];
    expect(
      render('"Alice\'s Tools" PR #42', {
        githubRepo,
        githubRepositories: quotedRepositories,
      })
        .querySelector("a")
        ?.getAttribute("href"),
    ).toBe("https://github.com/acme/tools/pull/42");
  });

  it.each(["Release Tools (Legacy)", "Build:"])(
    "preserves punctuation belonging to known alias %s",
    (alias) => {
      for (const origin of [{ owner: "other", repo: "tools" }, {}]) {
        const options = { githubRepo, githubRepositories: [{ ...origin, aliases: [alias] }] };
        for (const qualified of [alias, "(" + alias + ")"]) {
          const href = render(qualified + " PR #42", options)
            .querySelector("a")
            ?.getAttribute("href");
          expect(href ?? null).toBe(
            "owner" in origin ? "https://github.com/other/tools/pull/42" : null,
          );
        }
      }
    },
  );

  it("leaves references plain without a repository", () => {
    const fragment = render("PR #141270 issue #123 #141270", {});
    expect(fragment.querySelector("a")).toBeNull();
  });

  it.each([
    ["PR #141270", "PR ", "141270", "pull"],
    ["pull request #123", "pull request ", "123", "pull"],
    ["PuLl #123", "PuLl ", "123", "pull"],
    ["pr #1", "pr ", "1", "pull"],
    ["Closes #123", "Closes ", "123", "issue"],
    ["#1000", "", "1000", "issue"],
    ["reissue #141270", "reissue ", "141270", "issue"],
    ["issue #9999999999", "issue ", "9999999999", "issue"],
  ])("renders %s through the existing GitHub chip classifier", (input, prefix, number, kind) => {
    const fragment = render(input);
    const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    const href = `https://github.com/openclaw/openclaw/${kind === "pull" ? "pull" : "issues"}/${number}`;
    expect(anchor?.getAttribute("href")).toBe(href);
    expect(anchor?.classList.contains("markdown-github-link")).toBe(true);
    expect(anchor?.dataset.githubKind).toBe(kind);
    expect(anchor?.textContent).toBe(`#${number}`);
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(anchor?.previousSibling?.textContent ?? "").toBe(prefix);
    expect(fragment.textContent).toBe(`${input}\n`);
  });

  it.each([
    "#42",
    "#1a2b3c",
    "PR #0123",
    "issue #12345678901",
    "#141270suffix",
    "#141270.txt",
    "word#141270",
    "`PR #141270`",
    "```text\nPR #141270\n```",
    "[PR #141270](https://example.test)",
    "PR #141270\n===========",
    "/path#141270",
  ])("does not infer an item from %j", (input) => {
    const fragment = render(input, { githubRepo, fileLinks: true, sessionLinks: true });
    expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
    expect(fragment.querySelector("a a")).toBeNull();
  });

  it.each([
    ["PR **#1576 opened**", "PR #1576 opened", "1576", "pull"],
    ["**PR** #42", "PR #42", "42", "pull"],
    ["pull **request** *#42*", "pull request #42", "42", "pull"],
    ["*issue* **#42**", "issue #42", "42", "issue"],
  ])("preserves the item kind across emphasis in %s", (input, label, number, kind) => {
    const fragment = render(input);
    const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    expect(anchor?.getAttribute("href")).toBe(
      `https://github.com/openclaw/openclaw/${kind === "pull" ? "pull" : "issues"}/${number}`,
    );
    expect(anchor?.dataset.githubKind).toBe(kind);
    expect(anchor?.textContent).toBe(`#${number}`);
    expect(fragment.textContent?.trim()).toBe(label);
    expect(fragment.querySelector("strong, em")).not.toBeNull();
  });

  it.each([
    "re**PR** #42",
    "**PR**fix #42",
    "PR **#42**.txt",
    "PR `code` **#42**",
    "`PR` **#42**",
    "[PR](https://example.test) **#42**",
    "PR ![image](https://example.test/image.png) **#42**",
    "PR\n\n**#42**",
  ])("does not carry keyword context across non-emphasis boundaries in %s", (input) => {
    const fragment = render(input);
    expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
  });

  it("keeps punctuation and keywords outside adjacent chips and resumes after headings and links", () => {
    const input =
      "# PR #141270\n\n(PR #141270), issue #123; [#141270](https://example.test) and #141271!";
    const fragment = render(input);
    const anchors = fragment.querySelectorAll("a.markdown-github-item");
    expect([...anchors].map((anchor) => anchor.textContent)).toEqual([
      "#141270",
      "#123",
      "#141271",
    ]);
    expect(fragment.querySelector("p")?.textContent).toBe(
      "(PR #141270), issue #123; #141270 and #141271!",
    );
    expect(fragment.querySelector("h1 a")).toBeNull();
  });

  it.each([
    ["Fixed PR #141270.", "pull", "#141270"],
    ["Closes #123: done.", "issue", "#123"],
  ])("links a reference that ends a sentence in %j", (input, kind, label) => {
    const fragment = render(input);
    const anchor = fragment.querySelector("a.markdown-github-item");
    expect(anchor?.textContent).toBe(label);
    expect(anchor?.getAttribute("data-github-kind")).toBe(kind);
    expect(fragment.querySelector("p")?.textContent).toBe(input);
  });

  it("encodes repository path segments in streaming references", () => {
    const source = "PR **#141270**";
    const options = { githubRepo: { owner: "some owner", repo: "repo/name" } };
    const fragment = htmlFragment(toStreamingMarkdownParts(source, options).join(""));
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/some%20owner/repo%2Fname/pull/141270",
    );
  });
});
