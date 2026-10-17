import { createComponent, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { TEST_LINK_READER, testLinkPreview } from "../test-helpers/link-reader.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { LinkReaderContent } from "./link-reader-content.tsx";
import type { LoadImage } from "./link-reader-markdown.tsx";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { expectIncludes, text } from "./link-reader.test-support.ts";

type ReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
const url = "https://github.com/acme/project/pull/42";
const imagesUrl = "https://images.example/";
const target: LinkReaderTarget = { href: url, reader: TEST_LINK_READER };
const makeComment = (
  id: string,
  body: string,
  extra: Partial<ReaderComment> = {},
): ReaderComment => ({ id, url: url + "#" + id, author: "reviewer", body, ...extra });
function expectText(root: ParentNode, values: Record<string, string>) {
  expect(
    Object.fromEntries(Object.keys(values).map((selector) => [selector, text(root, selector)])),
  ).toEqual(values);
}
const codeText = (root: ParentNode) =>
  [...root.querySelectorAll("code")].map((node) => node.textContent?.trim());
function detail(body: string, comments: ReaderComment[] = []): ControlUiLinkReaderDocument {
  return {
    ...testLinkPreview({ url, metadata: undefined }),
    createdAt: "2026-09-01T12:00:00Z",
    body,
    comments,
    commentsTotal: comments.length,
    files: [],
  };
}
function mount(value: ControlUiLinkReaderDocument, link = target, loadImage?: LoadImage) {
  const [state, setState] = createSignal({ detail: value, target: link });
  const mounted = mountSolid(() =>
    createComponent(LinkReaderContent, {
      get detail() {
        return state().detail;
      },
      get target() {
        return state().target;
      },
      loadImage,
    }),
  );
  flush();
  return Object.assign(mounted.container, {
    update(next: ControlUiLinkReaderDocument, nextTarget = link) {
      setState({ detail: next, target: nextTarget });
      flush();
    },
    unmount: mounted.unmount,
  });
}
function mountMarkdown(body: string | string[], comments: ReaderComment[] = []) {
  return mount(detail(Array.isArray(body) ? body.join("\n\n") : body, comments));
}

describe("link reader document content", () => {
  it.each([
    ["success", "Checks passed"],
    ["unavailable", "Checks unavailable"],
  ] as const)("renders passive %s checks", (state, label) => {
    const container = mount({
      ...detail("Description"),
      checks: {
        state,
        summary: "Provider-owned result",
        total: 1,
        items: [{ name: "Build", state: "pending", detail: "Queued", url: "/run" }],
        url: url + "/checks",
        commit: "abcdef0123456789",
      },
    });
    const checks = container.querySelector<HTMLDetailsElement>(".lr-checks")!;
    expectText(checks, { "summary strong": label, ".lr-checks-footer code": "abcdef0" });
    expect(checks.open).toBe(false);
    expect(checks.textContent).toContain("Provider-owned result");
    expect(checks.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("In progress");
    const run = checks.querySelector<HTMLAnchorElement>(".lr-check-copy a")!;
    expect(run.href).toBe("https://github.com/run");
    expect(run.rel).toContain("noreferrer");
    expect(run.hasAttribute("data-link-reader-external")).toBe(true);
    expect(checks.querySelector(".lr-checks-meter") === null).toBe(state === "unavailable");
  });

  it("does not present incomplete check collections as a full meter or activate unsafe run URLs", () => {
    const container = mount({
      ...detail("Description"),
      checks: {
        state: "unavailable",
        summary: "Some checks could not load",
        total: 4,
        truncated: true,
        items: [{ name: "<script>unsafe</script>", state: "failure", url: "javascript:alert(1)" }],
        url: "https://user:password@github.com/private",
      },
    });
    expect(container.querySelector(".lr-checks-meter")).toBeNull();
    expect(container.querySelector(".lr-checks a, .lr-checks script")).toBeNull();
    expect(text(container, ".lr-check-copy")).toContain("<script>unsafe</script>");
    expect(text(container, ".lr-checks")).toContain("Some checks could not be shown");
  });

  it("hides HTML comment metadata while preserving visible prose and literal code examples", () => {
    const container = mountMarkdown(
      [
        "<!-- hidden-block\nmetadata --> <!-- hidden-adjacent -->",
        "  <!-- hidden-indented -->",
        "Visible description with <!-- hidden-inline --> text.",
        "`<!-- inline example -->`",
        "```html\n<!-- fenced example -->\n```",
        "    <!-- indented example -->",
        "&lt;!-- escaped example --&gt;",
        "<!-- hidden-prefix -->Trailing text<!-- hidden-suffix -->More text",
        "<!-- hidden-unclosed",
      ],
      [makeComment("c1", "<!-- hidden-ack --> <!-- hidden-status -->\n\nReview requested.")],
    );
    expect(container.textContent).not.toContain("hidden-");
    expectIncludes(container, "Visible description with  text.", "Trailing textMore text");
    expect(text(container, "#c1")).toContain("Review requested.");
    expect(codeText(container)).toEqual([
      "<!-- inline example -->",
      "<!-- fenced example -->",
      "<!-- indented example -->",
    ]);
    expect(container.textContent).toContain("<!-- escaped example -->");
  });

  it("renders emoji shortcodes in descriptions, comments, tables, links, and summaries", () => {
    const container = mountMarkdown("## :rocket: Ready", [
      makeComment(
        "emoji",
        [
          ":white_check_mark: Covered.",
          "| Status | Coverage |\n| --- | --- |\n| :warning: | **:white_check_mark:** |",
          "[:umbrella: Full report](https://coverage.example/report)",
          ":loudspeaker: Share feedback.",
          "<details><summary>:rocket: New features</summary>\n\n:snowflake: Analytics\n\n</details>",
          ":not_a_real_emoji: :) :+1:",
        ].join("\n\n"),
      ),
    ]);
    expect(text(container, ".lr-description h2")).toBe("🚀 Ready");
    const comment = container.querySelector("#emoji")!;
    expectText(comment, {
      td: "⚠️",
      "td strong": "✅",
      summary: "🚀 New features",
      'a[href="https://coverage.example/report"]': "☔ Full report",
    });
    expect(text(comment, "details")).toContain("❄️ Analytics");
    expectIncludes(comment, "✅ Covered.", "📢 Share feedback.", ":not_a_real_emoji: :) 👍");
  });

  it("keeps code, URLs, attributes, and escaped shortcodes literal without widening HTML trust", () => {
    const container = mountMarkdown([
      "Inline `:rocket:`.",
      "```text\n:warning: :umbrella:\n```",
      "    :white_check_mark:",
      "https://coverage.example/:rocket:/report",
      "<https://coverage.example/:warning:/report>",
      '[Report :rocket:](https://coverage.example/:rocket:/report ":warning:")',
      '![Alt :rocket:](https://images.example/:rocket:.png ":warning:")',
      '<img alt="Raw :rocket:" src="https://images.example/:warning:.png" onerror="alert(1)">',
      '<span title=":rocket:">:warning:</span>',
      "[Unsafe :rocket:](javascript:alert(1))",
      "\\:rocket: :unknown_emoji:",
    ]);
    expect(codeText(container)).toEqual([":rocket:", ":warning: :umbrella:", ":white_check_mark:"]);
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".lr-description a")];
    for (const emoji of ["rocket", "warning"]) {
      const href = `https://coverage.example/:${emoji}:/report`;
      expect(links.find((link) => link.textContent === href)?.href).toBe(href);
    }
    const authored = links.find((link) => link.textContent === "Report 🚀")!;
    expect(authored).toMatchObject({
      href: "https://coverage.example/:rocket:/report",
      title: ":warning:",
    });
    expect([...container.querySelectorAll("img")].map((image) => [image.src, image.alt])).toEqual([
      ["https://images.example/:rocket:.png", "Alt :rocket:"],
      ["https://images.example/:warning:.png", "Raw :rocket:"],
    ]);
    expectIncludes(
      container,
      '<span title=":rocket:">⚠️</span>',
      "Unsafe 🚀",
      ":rocket: :unknown_emoji:",
    );
    expect(
      container.querySelector('[onerror], a[href^="javascript:"], span[title=":rocket:"]'),
    ).toBeNull();
  });

  it("renders Markdown and HTML attachments with anonymous requests, source-relative URLs, and full-size links", () => {
    const container = mountMarkdown([
      "![Screenshot](/user-attachments/assets/first)",
      '<img alt="HTML attachment" src="https://user-images.githubusercontent.com/123/image.png" onerror="alert(1)" srcset="https://bad.example/tracker.png 2x">',
      "[Repository document](/docs/guide)",
      "[Another issue](../issues/43)",
    ]);
    const images = [...container.querySelectorAll("img")];
    expect(images.map((image) => image.src)).toEqual([
      "https://github.com/user-attachments/assets/first",
      "https://user-images.githubusercontent.com/123/image.png",
    ]);
    for (const image of images) {
      expect(image).toMatchObject({ crossOrigin: "anonymous", referrerPolicy: "no-referrer" });
      expect(image.hasAttribute("onerror")).toBe(false);
      expect(image.hasAttribute("srcset")).toBe(false);
      const open = image.closest("a");
      expect(open).toMatchObject({ href: image.src, target: "_blank" });
      expect(open?.rel).toContain("noreferrer");
      expect(open?.getAttribute("aria-label")).toContain(image.alt);
      open?.focus();
      expect(document.activeElement).toBe(open);
    }
    expect([...container.querySelectorAll("a")].map((link) => link.href)).toEqual(
      expect.arrayContaining([
        "https://github.com/docs/guide",
        "https://github.com/acme/project/issues/43",
      ]),
    );
  });

  it("keeps image failures visible and actionable across unchanged document renders, preserving authored links", () => {
    const value = detail(
      "[![Build status](https://images.example/status.png)](https://example.com/build)",
    );
    const container = mount(value);
    const image = container.querySelector("img")!;
    expect(image.closest("a")?.href).toBe("https://example.com/build");
    image.dispatchEvent(new Event("error"));
    expect(image.hidden).toBe(true);
    expect(container.textContent).toContain("Image unavailable: Build status");
    const original = container.querySelector<HTMLAnchorElement>("a[data-link-reader-external]");
    expect(original?.href).toBe("https://images.example/status.png");
    expect(container.querySelector("a a")).toBeNull();
    container.update({ ...value, title: "Updated title" });
    expect(container.querySelector("img")).toBe(image);
    expect(container.textContent).toContain("Image unavailable: Build status");
  });

  it("keeps image requests with their Markdown view and ignores results after replacement or unmount", async () => {
    const pending = new Map<string, (value: string) => void>();
    const loadImage = vi.fn(
      (source: string) =>
        new Promise<string>((resolve) => {
          pending.set(source, resolve);
        }),
    );
    const first = detail(`![First](${imagesUrl}first.png)`);
    const container = mount(first, target, loadImage);
    const firstImage = container.querySelector("img")!;
    container.update({ ...first, title: "New title" });
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBe(firstImage);

    container.update(detail(`![Second](${imagesUrl}second.png)`));
    const secondImage = container.querySelector("img")!;
    pending.get(imagesUrl + "first.png")!("blob:first");
    await Promise.resolve();
    expect(firstImage.hasAttribute("src")).toBe(false);
    expect(secondImage.hasAttribute("src")).toBe(false);
    firstImage.dispatchEvent(new Event("error"));
    expect(firstImage.hidden).toBe(false);

    container.unmount();
    pending.get(imagesUrl + "second.png")!("blob:second");
    await Promise.resolve();
    expect(secondImage.hasAttribute("src")).toBe(false);
    secondImage.dispatchEvent(new Event("error"));
    expect(secondImage.hidden).toBe(false);
  });

  it("never creates image requests for unsafe/local sources or activates remote document instructions", () => {
    const sources = [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "file:///secret.png",
      "https://example:not-a-real-password@images.example/secret.png",
      "http://images.example/insecure.png",
      ...[
        "127.0.0.1",
        "2130706433",
        "10.0.0.1",
        "0.0.0.0",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "localhost",
        "host.local",
        "metadata.google.internal",
        "intranet",
      ].map((host) => `https://${host}/image.png`),
      new URL("/private.png", window.location.href).href,
    ];
    const container = mountMarkdown([
      ...sources.map((source, index) => "![Blocked " + index + "](" + source + ")"),
      "<script>alert(1)</script>",
      '<iframe src="https://bad.example"></iframe>',
      "<openclaw-agent-chat></openclaw-agent-chat>",
      '[embed ref="cv_bad" /]',
      "[unsafe](javascript:alert(1))",
      "- [ ] Read-only task",
      '`<img src="https://images.example/code.png">`',
    ]);
    expect(
      container.querySelector(
        "img, script, iframe, openclaw-agent-chat, [data-file-path], [data-code], [onerror], a[href^='javascript:']",
      ),
    ).toBeNull();
    expect(container.textContent).toContain('[embed ref="cv_bad" /]');
    expect(container.querySelector('input[type="checkbox"]')).toMatchObject({ disabled: true });
    expect(text(container, "code")).toContain('<img src="https://images.example/code.png">');
    expect(container.textContent).toContain("Image unavailable");
  });

  it("renders plugin-projected comment anchors and context without deriving service semantics", () => {
    const reviewComment = (id: string, extra: Partial<ReaderComment> = {}) =>
      makeComment(id, `![Review image](${imagesUrl}review.png)`, {
        createdAt: "2026-09-02T12:00:00Z",
        ...extra,
      });
    const comments: ReaderComment[] = [
      reviewComment("issuecomment-7"),
      reviewComment("discussion_r7", {
        label: "Review comment",
        bodyTruncated: true,
        context: {
          path: "src/reader.ts",
          lineLabel: "4–6",
          label: "Before change · Outdated",
          replyUrl: url + "#discussion_r3",
          replyLabel: "Reply to comment #3",
          diff: "@@ -4 +4 @@\n-previous\n+<script>literal</script>",
          diffTruncated: true,
        },
      }),
    ];
    const container = mount(detail("Description", comments));
    const review = container.querySelector("#discussion_r7")!;
    expect(container.querySelector("#issuecomment-7")).not.toBeNull();
    expectIncludes(review, "Review comment", "src/reader.ts:4–6", "Before change · Outdated");
    expect(review.querySelector('a[href="' + url + '#discussion_r3"]')?.textContent).toContain(
      "Reply to comment #3",
    );
    expect(text(review, ".lr-diff-line--add")).toBe("+<script>literal</script>");
    expect(review.querySelector("script")).toBeNull();
    expectIncludes(review, "This diff was shortened", "This text was shortened");
    expect(review.querySelector("img")?.alt).toBe("Review image");
    const commitUrl = "https://github.com/acme/project/commit/abcdef1234567890";
    container.update(
      {
        ...detail("Commit message"),
        url: commitUrl,
        badge: { label: "Commit", tone: "neutral" },
        comments: [reviewComment("commitcomment-7", { url: commitUrl + "#commitcomment-7" })],
      },
      { ...target, href: commitUrl },
    );
    expect(container.querySelector("#commitcomment-7 img")).not.toBeNull();
    expect(text(container, ".lr-state")).toBe("Commit");
  });

  it("renders a second service's metadata, files, comments and truncation using only the passive document contract", () => {
    const link = { href: "https://forge.example/items/42", reader: TEST_LINK_READER };
    const container = mount(
      {
        url: link.href,
        title: "Change C42",
        subtitle: "Team changes",
        badge: { label: "Needs review", tone: "attention" },
        author: "Alex",
        authorUrl: "https://forge.example/users/alex",
        coAuthors: [{ name: "Sam" }, { name: "Noor" }],
        coAuthorCount: 3,
        metadata: [{ label: "Build", value: "Passed", tone: "positive" }],
        body: "[Next change](C43)",
        partial: true,
        bodyTruncated: true,
        comments: [
          makeComment("note-n1", "A note", {
            url: "#note-n1",
            author: "Sam",
            context: { replyUrl: "javascript:alert(1)", replyLabel: "Unsafe reply" },
          }),
        ],
        commentsTotal: 3,
        commentsTruncated: true,
        files: [
          {
            path: "src/new.ts",
            previousPath: "src/old.ts",
            additions: 1,
            deletions: 1,
            patch: "-old\n+new",
            patchTruncated: true,
          },
          { path: "image.png", additions: 0, deletions: 0 },
        ],
        filesTotal: 4,
        filesTruncated: true,
        filesExpanded: true,
      },
      link,
    );
    expectText(container, {
      h1: "Change C42",
      ".lr-metric dt": "Build",
      ".lr-metric dd": "Passed",
      ".lr-coauthors": "Co-authors: Sam, Noor +1",
      ".lr-metric--positive dd": "Passed",
      ".lr-state--attention": "Needs review",
      'a[href="https://forge.example/items/42#note-n1"]': "Link to this comment",
    });
    expect(container.querySelector(".lr-item-meta a")?.getAttribute("href")).toBe(
      "https://forge.example/users/alex",
    );
    expect(container.querySelector('a[href="https://forge.example/items/C43"]')).not.toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(text(container, "#note-n1")).toContain("A note");
    expect(container.querySelector<HTMLDetailsElement>(".lr-file")?.open).toBe(true);
    expect(container.textContent).not.toContain("This view is incomplete");
    expectIncludes(
      container,
      "Renamed from src/old.ts",
      "Some comments could not be shown",
      "Some files could not be shown",
      "No text diff available",
    );
  });
});
