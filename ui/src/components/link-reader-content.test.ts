import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { renderLinkReaderContent } from "./link-reader-content.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";

type ReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
const url = "https://github.com/acme/project/pull/42";
const target: LinkReaderTarget = {
  href: url,
  reader: {
    pluginId: "github",
    id: "github",
    label: "GitHub",
    linkReader: {
      hosts: ["github.com"],
      pathPattern: "^/[^/]+/[^/]+/pull/[0-9]+$",
      detailMethod: "github.detail",
    },
  },
};
function detail(body: string, comments: ReaderComment[] = []): ControlUiLinkReaderDocument {
  return {
    url,
    title: "Review the change",
    subtitle: "acme/project #42",
    author: "author",
    badge: { label: "Open", tone: "positive" },
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    body,
    comments,
    commentsTotal: comments.length,
    files: [],
  };
}
function mount(value: ControlUiLinkReaderDocument, link = target) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderLinkReaderContent(value, link), container);
  return container;
}
afterEach(() => document.body.replaceChildren());

describe("link reader document content", () => {
  it("hides HTML comment metadata while preserving visible prose and literal code examples", () => {
    const body = [
      "<!-- hidden-block\nmetadata --> <!-- hidden-adjacent -->",
      "  <!-- hidden-indented -->",
      "Visible description with <!-- hidden-inline --> text.",
      "`<!-- inline example -->`",
      "```html\n<!-- fenced example -->\n```",
      "    <!-- indented example -->",
      "&lt;!-- escaped example --&gt;",
      "<!-- hidden-prefix -->Trailing text<!-- hidden-suffix -->More text",
      "<!-- hidden-unclosed",
    ].join("\n\n");
    const container = mount(
      detail(body, [
        {
          id: "issuecomment-1",
          url: url + "#issuecomment-1",
          author: "review-bot",
          body: "<!-- hidden-ack --> <!-- hidden-status -->\n\nReview requested.",
        },
      ]),
    );
    expect(container.textContent).not.toContain("hidden-");
    expect(container.textContent).toContain("Visible description with  text.");
    expect(container.textContent).toContain("Trailing textMore text");
    expect(container.querySelector("#issuecomment-1")?.textContent).toContain("Review requested.");
    expect([...container.querySelectorAll("code")].map((code) => code.textContent?.trim())).toEqual(
      ["<!-- inline example -->", "<!-- fenced example -->", "<!-- indented example -->"],
    );
    expect(container.textContent).toContain("<!-- escaped example -->");
  });

  it("renders Markdown and HTML attachments with anonymous requests, source-relative URLs, and full-size links", () => {
    const container = mount(
      detail(
        [
          "![Screenshot](/user-attachments/assets/first)",
          '<img alt="HTML attachment" src="https://user-images.githubusercontent.com/123/image.png" onerror="alert(1)" srcset="https://bad.example/tracker.png 2x">',
          "[Repository document](/docs/guide)",
          "[Another issue](../issues/43)",
        ].join("\n\n"),
      ),
    );
    const images = [...container.querySelectorAll("img")];
    expect(images.map((image) => image.src)).toEqual([
      "https://github.com/user-attachments/assets/first",
      "https://user-images.githubusercontent.com/123/image.png",
    ]);
    for (const image of images) {
      expect(image.crossOrigin).toBe("anonymous");
      expect(image.referrerPolicy).toBe("no-referrer");
      expect(image.hasAttribute("onerror")).toBe(false);
      expect(image.hasAttribute("srcset")).toBe(false);
      const open = image.closest("a");
      expect(open?.href).toBe(image.src);
      expect(open?.target).toBe("_blank");
      expect(open?.rel).toContain("noreferrer");
      expect(open?.getAttribute("aria-label")).toContain(image.alt);
      open?.focus();
      expect(document.activeElement).toBe(open);
    }
    expect(container.querySelector('a[href="https://github.com/docs/guide"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://github.com/acme/project/issues/43"]'),
    ).not.toBeNull();
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
    render(renderLinkReaderContent(value, target), container);
    expect(container.querySelector("img")).toBe(image);
    expect(container.textContent).toContain("Image unavailable: Build status");
  });

  it("never creates image requests for unsafe/local sources or activates remote document instructions", () => {
    const userInfo = new URL("https://images.example/secret.png");
    userInfo.username = "example";
    userInfo.password = "not-a-real-password";
    const sources = [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "file:///secret.png",
      userInfo.href,
      "http://images.example/insecure.png",
      "https://127.0.0.1/image.png",
      "https://2130706433/image.png",
      "https://10.0.0.1/image.png",
      "https://0.0.0.0/image.png",
      "https://[::1]/image.png",
      "https://[::ffff:127.0.0.1]/image.png",
      "https://localhost/image.png",
      "https://host.local/image.png",
      "https://metadata.google.internal/image.png",
      "https://intranet/image.png",
      new URL("/private.png", window.location.href).href,
    ];
    const body = [
      ...sources.map((source, index) => "![Blocked " + index + "](" + source + ")"),
      "<script>alert(1)</script>",
      '<iframe src="https://bad.example"></iframe>',
      "<openclaw-agent-chat></openclaw-agent-chat>",
      '[embed ref="cv_bad" /]',
      "[unsafe](javascript:alert(1))",
      "- [ ] Read-only task",
      '`<img src="https://images.example/code.png">`',
    ].join("\n\n");
    const container = mount(detail(body));
    expect(
      container.querySelector(
        "img, script, iframe, openclaw-agent-chat, [data-file-path], [data-code], [onerror]",
      ),
    ).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('[embed ref="cv_bad" /]');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(
      true,
    );
    expect(container.querySelector("code")?.textContent).toContain(
      '<img src="https://images.example/code.png">',
    );
    expect(container.textContent).toContain("Image unavailable");
  });

  it("renders plugin-projected comment anchors and context without deriving service semantics", () => {
    const common = {
      author: "reviewer",
      createdAt: "2026-09-02T12:00:00Z",
      body: "![Review image](https://images.example/review.png)",
    };
    const comments: ReaderComment[] = [
      { ...common, id: "issuecomment-7", url: url + "#issuecomment-7" },
      {
        ...common,
        id: "discussion_r7",
        url: url + "#discussion_r7",
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
      },
    ];
    const container = mount(detail("Description", comments));
    const review = container.querySelector("#discussion_r7")!;
    expect(container.querySelector("#issuecomment-7")).not.toBeNull();
    expect(review.textContent).toContain("Review comment");
    expect(review.textContent).toContain("src/reader.ts:4–6");
    expect(review.textContent).toContain("Before change · Outdated");
    expect(review.querySelector('a[href="' + url + '#discussion_r3"]')?.textContent).toContain(
      "Reply to comment #3",
    );
    expect(review.querySelector(".lr-diff-line--add")?.textContent).toBe(
      "+<script>literal</script>",
    );
    expect(review.querySelector("script")).toBeNull();
    expect(review.textContent).toContain("This diff was shortened");
    expect(review.textContent).toContain("This text was shortened");
    expect(review.querySelector("img")?.alt).toBe("Review image");
    const commitUrl = "https://github.com/acme/project/commit/abcdef1234567890";
    render(
      renderLinkReaderContent(
        {
          ...detail("Commit message"),
          url: commitUrl,
          badge: { label: "Commit", tone: "neutral" },
          comments: [{ ...common, id: "commitcomment-7", url: commitUrl + "#commitcomment-7" }],
        },
        { ...target, href: commitUrl },
      ),
      container,
    );
    expect(container.querySelector("#commitcomment-7 img")).not.toBeNull();
    expect(container.querySelector(".lr-state")?.textContent).toBe("Commit");
  });

  it("renders a second service's metadata, files, comments and truncation using only the passive document contract", () => {
    const link: LinkReaderTarget = {
      href: "https://forge.example/changes/C42",
      reader: {
        pluginId: "forge",
        id: "changes",
        label: "Changes",
        linkReader: {
          hosts: ["forge.example"],
          pathPattern: "^/changes/[^/]+$",
          detailMethod: "forge.read",
        },
      },
    };
    const container = mount(
      {
        url: "https://forge.example/changes/C42",
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
          {
            id: "note-n1",
            url: "#note-n1",
            author: "Sam",
            body: "A note",
            context: { replyUrl: "javascript:alert(1)", replyLabel: "Unsafe reply" },
          },
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
    expect(container.querySelector("h1")?.textContent).toBe("Change C42");
    expect(container.textContent).toContain("Build: Passed");
    expect(container.querySelector(".lr-item-meta a")?.getAttribute("href")).toBe(
      "https://forge.example/users/alex",
    );
    expect(container.querySelector(".lr-coauthors")?.textContent).toBe("Co-authors: Sam, Noor +1");
    expect(container.querySelector(".lr-item-meta [data-tone=positive]")?.textContent).toBe(
      "Passed",
    );
    expect(container.querySelector(".lr-state--attention")?.textContent).toBe("Needs review");
    expect(container.querySelector('a[href="https://forge.example/changes/C43"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://forge.example/changes/C42#note-n1"]')?.textContent,
    ).toBe("Link to this comment");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("#note-n1")?.textContent).toContain("A note");
    expect(container.querySelector<HTMLDetailsElement>(".lr-file")?.open).toBe(true);
    expect(container.textContent).toContain("Renamed from src/old.ts");
    expect(container.textContent).toContain("This view is incomplete");
    expect(container.textContent).toContain("Some comments could not be shown");
    expect(container.textContent).toContain("Some files could not be shown");
    expect(container.textContent).toContain("No text diff available");
  });
});
