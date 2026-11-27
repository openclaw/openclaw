import { createComponent, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { LinkReaderContent } from "./link-reader-content.tsx";
import type { LoadImage } from "./link-reader-markdown.tsx";
import type { ReaderReadyView } from "./link-reader-panel-view.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";

type ReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
const comment = (body: string, extra: Partial<ReaderComment> = {}): ReaderComment => ({
  id: "comment",
  url: "#comment",
  author: "reviewer",
  body,
  ...extra,
});
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
    body,
    comments,
    commentsTotal: comments.length,
    files: [],
  };
}
const updates = new WeakMap<HTMLElement, (value: ControlUiLinkReaderDocument) => void>();
const unmounts = new WeakMap<HTMLElement, () => void>();
function mount(
  value: ControlUiLinkReaderDocument,
  link = target,
  loadImage?: LoadImage,
  extra: Pick<Parameters<typeof LinkReaderContent>[0], "sections" | "onLoadSection"> = {},
) {
  const [state, setState] = createSignal(value);
  const mounted = mountSolid(() =>
    createComponent(LinkReaderContent, {
      get detail() {
        return state();
      },
      target: link,
      loadImage,
      get sections() {
        return extra.sections;
      },
      onLoadSection: extra.onLoadSection,
    }),
  );
  updates.set(mounted.container, setState);
  unmounts.set(mounted.container, mounted.unmount);
  flush();
  return mounted.container;
}
function update(container: HTMLElement, value: ControlUiLinkReaderDocument) {
  updates.get(container)!(value);
  flush();
}

describe("link reader document content", () => {
  it("loads only idle file sections entering the viewport and retires observation", () => {
    let deliver!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
    let observed!: Element;
    const notifyVisible = (intersecting = true) => {
      deliver([{ target: observed, isIntersecting: intersecting }]);
    };
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof deliver) {
          deliver = callback;
        }
        observe(element: Element) {
          observed = element;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const loadSection = vi.fn();
    const [sections, setSections] = createSignal<ReaderReadyView["sections"]>({
      checks: "idle",
      files: "idle",
      discussion: "idle",
    });
    const container = mount(
      { ...detail("Description"), files: undefined, comments: undefined },
      target,
      undefined,
      {
        get sections() {
          return sections();
        },
        onLoadSection: loadSection,
      },
    );
    expect(observed.getAttribute("data-reader-section")).toBe("files");
    notifyVisible(false);
    expect(loadSection).not.toHaveBeenCalled();
    notifyVisible();
    expect(loadSection).toHaveBeenCalledExactlyOnceWith("files");
    loadSection.mockClear();

    for (const state of ["loading", "error"] as const) {
      setSections({ files: state, checks: "idle", discussion: "idle" });
      flush();
      notifyVisible();
      expect(loadSection).not.toHaveBeenCalled();
    }
    setSections({ files: "idle" });
    flush();
    notifyVisible();
    expect(loadSection).toHaveBeenCalledExactlyOnceWith("files");
    loadSection.mockClear();
    unmounts.get(container)!();
    notifyVisible();
    expect(loadSection).not.toHaveBeenCalled();
  });

  it("renders successful checks without assuming service-specific labels", () => {
    const container = mount({
      ...detail("Description"),
      checks: {
        state: "success",
        summary: "Provider-owned result",
        total: 1,
        items: [
          {
            name: "Build",
            state: "pending",
            detail: "Queued",
            url: "/acme/project/actions/runs/1",
          },
        ],
        url: url + "/checks",
        commit: "abcdef0123456789",
      },
    });
    const checks = container.querySelector<HTMLElement>(".lr-checks")!;
    const toggle = checks.querySelector<HTMLButtonElement>(".lr-checks-summary")!;
    expect(toggle.querySelector("strong")?.textContent).toBe("Checks passed");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Counted states come from the passive items; the source's own summary stays reachable.
    const legend = checks.querySelector<HTMLElement>(".lr-checks-legend")!;
    expect(legend.textContent).toBe("1 in progress");
    expect(legend.title).toBe("Provider-owned result");
    expect(checks.querySelector(".lr-check")).toBeNull();
    toggle.click();
    flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(checks.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("In progress");
    expect(checks.querySelector(".lr-check-detail")?.textContent).toBe("Queued");
    const run = checks.querySelector<HTMLAnchorElement>("a.lr-check-row")!;
    expect(run.href).toBe("https://github.com/acme/project/actions/runs/1");
    expect(run.rel).toContain("noreferrer");
    expect(run.hasAttribute("data-link-reader-external")).toBe(true);
    expect(checks.querySelector(".lr-checks-footer code")?.textContent).toBe("abcdef0");
    expect(checks.querySelector(".lr-checks-meter")).not.toBeNull();
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
    // One known run of four: the ring leaves the rest open, and the legend counts it.
    const segments = [...container.querySelectorAll(".lr-checks-meter .lr-check-segment")];
    expect(segments).toHaveLength(1);
    expect(Number.parseFloat(segments[0]!.getAttribute("stroke-dasharray")!)).toBeLessThan(30);
    expect(container.querySelector(".lr-checks-summary strong")?.textContent).toBe(
      "Checks incomplete",
    );
    expect(container.querySelector(".lr-checks-legend")?.textContent).toBe("1 failed3 not shown");
    // A failed run is named while the full list is collapsed.
    expect(container.querySelector(".lr-checks-summary")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(container.querySelector(".lr-checks a, .lr-checks script")).toBeNull();
    expect(container.querySelector(".lr-checks-title span")?.textContent).toBe(
      "<script>unsafe</script>",
    );
    container.querySelector<HTMLButtonElement>(".lr-checks-summary")!.click();
    flush();
    expect(container.querySelector(".lr-checks a, .lr-checks script")).toBeNull();
    expect(container.querySelector(".lr-checks")?.textContent).toContain(
      "Couldn’t show all checks. Open the original to see them.",
    );
    update(container, {
      ...detail("Description"),
      checks: {
        state: "failure",
        summary: "Partial checks",
        total: 4,
        truncated: true,
        items: [],
        url: url + "/checks",
      },
    });
    // Without items there is nothing to count: the source's summary speaks, and no ring is drawn.
    expect(container.querySelector(".lr-checks-legend")?.textContent).toBe("Partial checks");
    expect(container.querySelector(".lr-checks-meter")).toBeNull();
    const source = container.querySelector<HTMLAnchorElement>(".lr-checks .lr-note a")!;
    expect(source).not.toBeNull();
    expect(source.textContent).toBe("View all checks on GitHub");
    expect(source.href).toBe(url + "/checks");
    expect(source.target).toBe("_blank");
    expect(source.hasAttribute("data-link-reader-external")).toBe(true);
  });

  it("numbers diff rows from their hunk headers and leaves the patch text intact", () => {
    const patch = [
      "@@ -10,3 +10,4 @@ export function run() {",
      " context",
      "-old",
      "+new",
      "+more",
      "\\ No newline at end of file",
    ].join("\n");
    const container = mount({
      ...detail("Description"),
      files: [
        { path: "src/reader/run.ts", status: "added", additions: 2, deletions: 1, patch },
        { path: "README.md", status: "modified", additions: 0, deletions: 0, patch: "+unnumbered" },
      ],
      filesExpanded: true,
    });
    const [file, root] = [...container.querySelectorAll(".lr-file")];
    // Numbers render from the attribute, so selecting the diff copies the patch itself.
    expect(
      [...file!.querySelectorAll(".lr-diff-line")].map((row) => [
        row.className.replace("lr-diff-line lr-diff-line--", ""),
        row.getAttribute("data-line"),
      ]),
    ).toEqual([
      ["hunk", null],
      ["context", "10"],
      ["delete", "11"],
      ["add", "11"],
      ["add", "12"],
      ["context", null],
    ]);
    expect(file!.querySelector(".lr-diff")?.textContent).toBe(patch.replaceAll("\n", ""));
    expect(file!.querySelector(".lr-file-name")?.textContent).toBe("run.ts");
    expect(file!.querySelector(".lr-file-directory")?.textContent).toBe("src/reader");
    expect(file!.querySelector(".lr-file-status")?.textContent).toBe("added");
    // A root file has no directory, an ordinary change no status, a bare patch no numbers.
    expect(root!.querySelector(".lr-file-directory, .lr-file-status")).toBeNull();
    expect(root!.querySelector(".lr-diff-line")?.hasAttribute("data-line")).toBe(false);
  });

  it("shows the author's picture only from a safe source and falls back to an initial", () => {
    const picture = "data:image/png;base64,AAAA";
    const container = mount({ ...detail("Description"), imageUrl: picture });
    expect(container.querySelector<HTMLImageElement>(".lr-author img")?.src).toBe(picture);
    update(container, { ...detail("Description"), imageUrl: "javascript:alert(1)" });
    expect(container.querySelector(".lr-author img")).toBeNull();
    expect(container.querySelector(".lr-author .lr-avatar")?.textContent).toBe("A");
  });

  it("admits bare emphasis tags in authored Markdown and keeps other HTML literal", () => {
    const container = mount(
      detail(
        [
          "<details><summary><strong>Agent review details</strong></summary>",
          "Inside",
          "</details>",
          'First<br>second <b class="x">attributed</b> <span onclick="x()">span</span>',
        ].join("\n\n"),
      ),
    );
    expect(container.querySelector(".lr-markdown summary strong")?.textContent).toBe(
      "Agent review details",
    );
    expect(container.querySelector(".lr-markdown br")).not.toBeNull();
    // A tag with attributes, or any other element, is authored text and nothing more.
    expect(container.querySelector(".lr-markdown span[onclick], .lr-markdown b")).toBeNull();
    const text = container.querySelector(".lr-markdown")?.textContent;
    expect(text).toContain('<b class="x">attributed');
    expect(text).toContain('<span onclick="x()">span</span>');
  });

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
      detail(body, [comment("<!-- hidden-ack --> <!-- hidden-status -->\n\nReview requested.")]),
    );
    expect(container.textContent).not.toContain("hidden-");
    expect(container.textContent).toContain("Visible description with  text.");
    expect(container.textContent).toContain("Trailing textMore text");
    expect(container.querySelector("#comment")?.textContent).toContain("Review requested.");
    expect([...container.querySelectorAll("code")].map((code) => code.textContent?.trim())).toEqual(
      ["<!-- inline example -->", "<!-- fenced example -->", "<!-- indented example -->"],
    );
    expect(container.textContent).toContain("<!-- escaped example -->");
  });

  it("renders Markdown and HTML attachments with anonymous requests, source-relative URLs, and full-size links", () => {
    const container = mount(
      detail(
        [
          "![Alt :rocket:](/user-attachments/assets/:rocket:)",
          '<img alt="Raw :rocket:" src="https://user-images.githubusercontent.com/123/:warning:.png" onerror="alert(1)" srcset="https://bad.example/tracker.png 2x">',
          '[Report :rocket:](/docs/:rocket: ":warning:")',
          "[Another issue](../issues/43)",
        ].join("\n\n"),
      ),
    );
    const images = [...container.querySelectorAll("img")];
    expect(images.map((image) => [image.src, image.alt])).toEqual([
      ["https://github.com/user-attachments/assets/:rocket:", "Alt :rocket:"],
      ["https://user-images.githubusercontent.com/123/:warning:.png", "Raw :rocket:"],
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
    expect(container.querySelector('a[href="https://github.com/docs/:rocket:"]')).toMatchObject({
      textContent: "Report 🚀",
      title: ":warning:",
    });
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
    const original = container.querySelector<HTMLAnchorElement>(
      ".lr-description a[data-link-reader-external]",
    );
    expect(original?.href).toBe("https://images.example/status.png");
    expect(container.querySelector("a a")).toBeNull();
    update(container, { ...value, title: "Updated title" });
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
    const first = detail("![First](https://images.example/first.png)");
    const container = mount(first, target, loadImage);
    const firstImage = container.querySelector("img")!;
    update(container, { ...first, title: "New title" });
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBe(firstImage);

    update(container, detail("![Second](https://images.example/second.png)"));
    const secondImage = container.querySelector("img")!;
    pending.get("https://images.example/first.png")!("blob:first");
    await Promise.resolve();
    expect(firstImage.hasAttribute("src")).toBe(false);
    expect(secondImage.hasAttribute("src")).toBe(false);
    firstImage.dispatchEvent(new Event("error"));
    expect(firstImage.hidden).toBe(false);

    unmounts.get(container)!();
    pending.get("https://images.example/second.png")!("blob:second");
    await Promise.resolve();
    expect(secondImage.hasAttribute("src")).toBe(false);
    secondImage.dispatchEvent(new Event("error"));
    expect(secondImage.hidden).toBe(false);
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
      "[Unsafe :rocket:](javascript:alert(1))",
      '<span title=":rocket:">:warning:</span>',
      "- [ ] Read-only task",
      '`<img src="https://images.example/code.png">`',
    ].join("\n\n");
    const container = mount(detail(body));
    expect(
      container.querySelector(
        "img, script, iframe, openclaw-agent-chat, [data-file-path], [data-code], [onerror]",
      ),
    ).toBeNull();
    expect(container.querySelector('a[href^="javascript:"], span[title=":rocket:"]')).toBeNull();
    expect(container.textContent).toContain('<span title=":rocket:">⚠️</span>');
    expect(container.textContent).toContain("Unsafe 🚀");
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
    const comments: ReaderComment[] = [
      comment("Ordinary comment", { id: "issuecomment-7", url: url + "#issuecomment-7" }),
      comment("Reply with no file location", {
        id: "reply-only",
        context: { replyUrl: "#issuecomment-7", replyLabel: "Parent comment" },
      }),
      comment("Review comment body", {
        createdAt: "2026-09-02T12:00:00Z",
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
      }),
    ];
    const container = mount(detail("Description", comments));
    const review = container.querySelector("#discussion_r7")!;
    expect(container.querySelector("#issuecomment-7")).not.toBeNull();
    const replyLinks = container.querySelectorAll<HTMLAnchorElement>(
      "#reply-only .lr-review-location a",
    );
    expect(Array.from(replyLinks, (link) => [link.textContent, link.href])).toEqual([
      ["Parent comment", url + "#issuecomment-7"],
    ]);
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
  });

  it("renders a second service's metadata, files, comments and truncation using only the passive document contract", () => {
    const link: LinkReaderTarget = {
      ...target,
      href: "https://forge.example/changes/C42",
      reader: {
        ...target.reader,
        pluginId: "forge",
        label: "Changes",
      },
    };
    const container = mount(
      {
        url: "https://forge.example/changes/C42",
        title: "Change C42",
        badge: { label: "Needs review", tone: "attention" },
        author: "Alex",
        authorUrl: "https://forge.example/users/alex",
        coAuthors: [{ name: "Sam" }, { name: "Noor" }],
        coAuthorCount: 3,
        metadata: [
          { label: "Build", value: "Passed", tone: "positive" },
          { label: "Additions", value: "+12", tone: "positive" },
        ],
        body: "[Next change](C43)",
        partial: true,
        bodyTruncated: true,
        comments: [
          comment("A note", {
            id: "note-n1",
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
    expect(container.querySelector("h1")?.textContent).toBe("Change C42");
    const labels = [...container.querySelectorAll(".lr-fact dt")];
    expect(labels.map((label) => [label.textContent, label.classList.contains("sr-only")])).toEqual(
      [
        ["Build", false],
        ["Additions", true],
      ],
    );
    expect(container.querySelector(".lr-byline a")?.getAttribute("href")).toBe(
      "https://forge.example/users/alex",
    );
    const coAuthors = container.querySelector(".lr-coauthors")!;
    expect(coAuthors.getAttribute("aria-label")).toBe("Co-authors: Sam, Noor +1");
    expect(coAuthors.textContent).toBe("SN+1");
    expect(container.querySelector(".lr-fact--positive dd")?.textContent).toBe("Passed");
    expect(container.querySelector(".lr-state--attention")?.textContent).toBe("Needs review");
    expect(container.querySelector('a[href="https://forge.example/changes/C43"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://forge.example/changes/C42#note-n1"]')?.textContent,
    ).toBe("Link to this comment");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("#note-n1")?.textContent).toContain("A note");
    expect(container.querySelector<HTMLDetailsElement>(".lr-file")?.open).toBe(true);
    expect(container.textContent).toContain("Renamed from src/old.ts");
    expect(container.textContent).not.toContain("This view is incomplete");
    expect(container.textContent).toContain("Couldn’t show all comments.");
    expect(container.textContent).toContain("Couldn’t show all files.");
    expect(container.textContent).toContain("No text diff available");
  });
});

it("renders document dates in the UI locale and leaves invalid external dates verbatim", () => {
  const locale = vi.spyOn(i18n, "getLocale").mockReturnValue("de");
  const createdAt = "2026-01-02T12:34:56Z";
  const container = mount({ ...detail("Example"), createdAt });
  try {
    // Older dates stay absolute, without seconds; the full timestamp remains in the title.
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe(
      new Date(createdAt).toLocaleString("de", { dateStyle: "medium" }),
    );
    expect(time.title).toBe(new Date(createdAt).toLocaleString("de"));
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    update(container, { ...detail("Example"), createdAt: recent });
    expect(container.querySelector("time")?.textContent).toBe("vor 2 Std.");
    update(container, { ...detail("Example"), createdAt: "external date" });
    expect(container.textContent).toContain("external date");
  } finally {
    locale.mockRestore();
  }
});
