import { expect, it, vi } from "vitest";
import { shortestFileLabels } from "./file-kind.ts";
import { markdownFileLinkFromEvent, parseMarkdownFileLinkTarget } from "./markdown-file-links.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const render = (source: string, options: MarkdownRenderOptions = { fileLinks: true }) =>
  htmlFragment(toSanitizedMarkdownHtml(source, options));

const fileLinks = (fragment: ParentNode) => [
  ...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link"),
];

function workspaceLink(fragment: ParentNode, path: string, line?: string, kind?: string) {
  const link = fileLinks(fragment)[0];
  expect([link?.dataset.filePath, link?.dataset.fileLine]).toEqual([path, line]);
  if (kind) {
    expect(link?.dataset.fileKind).toBe(kind);
  }
  const attributes = ["role", "tabindex", "href"].map((name) => link?.getAttribute(name));
  expect(attributes).toEqual(["button", "0", null]);
  return link;
}

function linkInfo(input: string) {
  return fileLinks(render(input)).map((link) => ({
    path: link.dataset.filePath,
    line: link.dataset.fileLine,
    label: link.textContent,
    title: link.getAttribute("title"),
  }));
}

it.each([
  ["see src/lib/foo.ts for details", "src/lib/foo.ts"],
  ["[x](/Users/a/b.ts)", "/Users/a/b.ts"],
])("links %s only when enabled", (source, path) => {
  workspaceLink(render(source), path);
  expect(render(source, {}).querySelector("a[href], a[data-file-path]")).toBeNull();
});

it.each<[string, string[], string[]?]>([
  ["~/n.md ./x.ts ../y.ts f.ts i.csv", ["~/n.md", "./x.ts", "../y.ts"], ["f.ts", "i.csv"]],
  ["rotated logs/app.log.1 but see src/lib/foo.ts.", ["src/lib/foo.ts"], ["logs/app.log.1"]],
  ["bumped 1.1/1.2 and `2026.9.2`, see v1.2/3.4 [part](assets/part.3mf)", ["assets/part.3mf"]],
  ["`a/x.ts` `x.ts` `i.csv` `f.b()` `n.xyz`", ["a/x.ts", "x.ts", "i.csv"], ["f.b()", "n.xyz"]],
  ["`e\u0301.md` and `C:\\文档\\café.md:9`", ["e\u0301.md", "C:\\文档\\café.md"]],
  ["`reader's [draft] (v2).md` Read the notes/readme.md now.", ["notes/readme.md"]],
  ...["./portal.example/service.test", ".config/workflows/check.yml", "src.v2/app.ts"].map(
    (path): [string, string[]] => [path, [path]],
  ),
])("recognizes workspace paths while preserving prose in %s", (input, paths, preserved = []) => {
  const fragment = render(input);
  expect(fileLinks(fragment).map((link) => link.dataset.filePath)).toEqual(paths);
  expect(fragment.querySelectorAll("a[data-file-path]")).toHaveLength(paths.length);
  for (const text of preserved) {
    expect(fragment.textContent).toContain(text);
  }
});

it("keeps authored CSV focusable and non-navigating", () => {
  const path = "inventory report.CSV";
  const markdown = `[Read inventory](${encodeURI(path)})`;
  const fragment = render(markdown);
  const link = workspaceLink(fragment, path);
  expect(link?.textContent).toBe("Read inventory");

  const disabled = render(markdown, {});
  expect(disabled.querySelector("a[data-file-path]")).toBeNull();
  expect(disabled.querySelector("a")?.getAttribute("href")).toBe(encodeURI(path));
});

it.each([
  "文档/说明.md",
  "qa-cafe\u0301/re\u0301sume\u0301.md",
  "qa files/reader's [draft] (v2).md",
  "literal%20name.txt",
])("preserves encoded Unicode and authored punctuation in %s", (path) => {
  const link = workspaceLink(render(`[Read file](${encodeURI(path)}:17)`), path, "17");
  expect(link?.textContent).toBe("Read file");
});

it("keeps authored URL and session destinations out of workspace file handling", () => {
  const destinations = [
    "https://example.com/caf%C3%A9%20note.md",
    "//example.com/emoji-%F0%9F%8C%B1.md",
    "notes/readme.md?raw=1",
    "/chat/main/notes/readme.md",
    "inventory.csv?download=1",
    "example.com",
  ];
  const fragment = render(destinations.map((href) => `[Read](${href})`).join("\n"), {
    fileLinks: true,
    sessionLinks: true,
  });
  expect(fragment.querySelector("a[data-file-path]")).toBeNull();
  expect([...fragment.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(
    destinations,
  );
});

it.each(["portal.example/service.test", "münich.de/guide.md", "example.xn--p1ai/guide.md"])(
  "never treats the domain/path reference %s as a workspace file",
  (reference) => {
    for (const input of [reference, `\`${reference}\``, `[website](${reference})`]) {
      const fragment = render(input);
      expect(fragment.querySelector("a[data-file-path]")).toBeNull();
      expect(fragment.textContent?.trim()).toBe(input.startsWith("[") ? "website" : reference);
    }
  },
);

it("does not link paths inside fenced code blocks", () => {
  const fragment = render("```ts\nsrc/lib/foo.ts:42\n```");
  expect(fragment.querySelector("a[data-file-path]")).toBeNull();
  expect(fragment.querySelector("code")?.textContent).toContain("src/lib/foo.ts:42");
});

it.each<[string, ...Partial<ReturnType<typeof linkInfo>[number]>[]]>([
  [
    "src/lib/foo.ts:42 and bar.ts:7:3",
    { path: "src/lib/foo.ts", line: "42", label: "foo.ts:42" },
    { path: "bar.ts", line: "7", label: "bar.ts:7:3" },
  ],
  ["`src/auth-options.static.ts:26-35`", { path: "src/auth-options.static.ts", line: "26" }],
  ["see a/X.tsx now", { path: "a/X.tsx", label: "X.tsx", title: "a/X.tsx" }],
  ["`README.md`", { label: "README.md", title: null }],
  ["[a/x.ts](a/x.ts)", { title: null }],
  [
    "`src/lib/foo.ts` and [the button](src/ui/Button.tsx:12)",
    { label: "foo.ts", title: "src/lib/foo.ts" },
    { label: "the button", title: "src/ui/Button.tsx:12" },
  ],
  ["u/a.ts v/a.ts `D:\\w\\a.ts`", { label: "u/a.ts" }, { label: "v/a.ts" }, { label: "w\\a.ts" }],
])("preserves file-line targets, labels, and tooltips in %s", (input, ...expected) => {
  expect(linkInfo(input)).toMatchObject(expected);
});

it("keeps per-path lookup cost linear as path count grows (performance contract)", () => {
  // #124230: detect the former O(n²) rescan without wall-clock timing.
  const countMapLookups = (pathCount: number): number => {
    const paths = Array.from({ length: pathCount }, (_, i) => `s/p${i % 50}/m${i}/f${i}.ts`);
    const getSpy = vi.spyOn(Map.prototype, "get");
    try {
      shortestFileLabels(paths);
      return getSpy.mock.calls.length;
    } finally {
      getSpy.mockRestore();
    }
  };

  const small = countMapLookups(500);
  const large = countMapLookups(4000); // 8x the paths

  expect(large).toBeGreaterThan(small * 4);
  expect(large).toBeLessThan(small * 16);
});

it.each<[string, string, string, string?]>([
  ["`C:\\skills\\review\\skill.MD`", "C:\\skills\\review\\skill.MD", "skill"],
  ["`skills/review/SKILL.markdown`", "skills/review/SKILL.markdown", "markdown"],
  ["`package.json`", "package.json", "package"],
  ["`src/components/Button.tsx`", "src/components/Button.tsx", "component"],
  ["`config/app.yaml`", "config/app.yaml", "data"],
  ["`scripts/run.sh`", "scripts/run.sh", "shell"],
  ["`assets/logo.svg`", "assets/logo.svg", "image"],
  ["[Read file](/tmp/constructor)", "/tmp/constructor", "file"],
  ["[Read file](/tmp/notes.__proto__)", "/tmp/notes.__proto__", "file"],
])("classifies %s without changing workspace navigation", (input, path, kind, line) => {
  workspaceLink(render(input), path, line, kind);
});

it.each([
  ["spaces", "see docs/my notes.md today"],
  ["parentheses", "see src/lib/foo(1).ts today"],
])("never pulls %s into a file path, and leaves the prose intact", (_kind, input) => {
  const fragment = render(input);
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")) {
    expect(link.dataset.filePath).not.toMatch(/[\s()?]/);
  }
  expect(fragment.textContent).toContain(input);
});

it("carries a persisted message identity without borrowing it for a forwarded session", () => {
  const bubble = document.createElement("div");
  bubble.dataset.entryId = "original-entry";
  bubble.append(render("[Notes](notes.md)"));
  let selected: ReturnType<typeof markdownFileLinkFromEvent> = null;
  bubble.addEventListener("click", (event) => {
    selected = markdownFileLinkFromEvent(event);
  });
  const link = bubble.querySelector<HTMLAnchorElement>("a")!;
  link.click();
  expect(selected).toMatchObject({ path: "notes.md", messageEntryId: "original-entry" });
  bubble.dataset.fileSessionKey = "agent:other:forwarded";
  link.click();
  expect(selected).toMatchObject({ sessionKey: "agent:other:forwarded" });
  expect(selected).not.toHaveProperty("messageEntryId");
  bubble.dataset.fileEntryId = "forwarded-source-entry";
  link.click();
  expect(selected).toMatchObject({ messageEntryId: "forwarded-source-entry" });
});

it.each([
  ["guide.md#intro", "guide.md", null, "intro"],
  ["guide.md:17#intro", "guide.md", 17, "intro"],
  ["guide%23draft.md#caf%C3%A9", "guide#draft.md", null, "café"],
  ["guide%2523draft.md", "guide%23draft.md", null, undefined],
  ["folder#draft/guide.md", "folder#draft/guide.md", null, undefined],
])("separates authored fragments from file identity in %s", (href, path, line, fragment) => {
  expect(parseMarkdownFileLinkTarget(href, { authored: true })).toEqual({
    path,
    line,
    ...(fragment !== undefined ? { fragment } : {}),
  });
  const anchor = workspaceLink(
    render("[Open](" + href + ")"),
    path,
    line ? String(line) : undefined,
  );
  expect(anchor?.dataset.fileFragment).toBe(fragment);
});

it("resolves authored links against their document without sharing a cached directory", () => {
  const source =
    "[Sibling](../other/guide.md#intro) [Local](#intro) [Session](/chat/main/guide.md)";
  for (const directory of ["first", "second"]) {
    const fragment = render(source, {
      fileLinks: true,
      sessionLinks: true,
      mode: "document",
      fileLinkBasePath: "/workspace/" + directory + "/docs/readme.md",
    });
    expect(
      fileLinks(fragment).map((link) => [link.dataset.filePath, link.dataset.fileFragment]),
    ).toEqual([
      ["/workspace/" + directory + "/other/guide.md", "intro"],
      ["/workspace/" + directory + "/docs/readme.md", "intro"],
    ]);
    expect(fragment.querySelector("a.markdown-session-link")?.getAttribute("href")).toBe(
      "/chat/main/guide.md",
    );
  }
});

it("assigns document-scoped heading fragments for inline formatting, Unicode, and duplicates", () => {
  const fragment = render(
    "## A **formatted** heading!\n\n## Café 雪\n\n## A formatted heading!\n\n## A formatted heading-1",
    { mode: "document", fileLinkBasePath: "/workspace/readme.md" },
  );
  expect(
    [...fragment.querySelectorAll("h2")].map((heading) =>
      heading.getAttribute("data-markdown-heading"),
    ),
  ).toEqual(["a-formatted-heading", "café-雪", "a-formatted-heading-1", "a-formatted-heading-1-1"]);
  expect(render("## Normal chat").querySelector("h2")?.hasAttribute("data-markdown-heading")).toBe(
    false,
  );
});

it.each([
  [String.raw`\\server\share\docs\readme.md`, String.raw`\\server\share\docs\guide.md`],
  ["//server/share/docs/readme.md", "//server/share/docs/guide.md"],
  [String.raw`C:\workspace\docs\readme.md`, String.raw`C:\workspace\docs\guide.md`],
])("preserves the document root and separator for %s", (basePath, expectedPath) => {
  const fragment = render("[Sibling](guide.md#details)", {
    fileLinks: true,
    mode: "document",
    fileLinkBasePath: basePath,
  });
  workspaceLink(fragment, expectedPath);
  expect(fileLinks(fragment)[0]?.dataset.fileFragment).toBe("details");
});

it.each([5, 6])("preserves a level-%s heading target through document sanitization", (level) => {
  const fragment = render("[Details](#details)\n\n" + "#".repeat(level) + " Details", {
    fileLinks: true,
    mode: "document",
    fileLinkBasePath: "/workspace/readme.md",
  });
  expect(fragment.querySelector("h" + level)?.getAttribute("data-markdown-heading")).toBe(
    "details",
  );
  workspaceLink(fragment, "/workspace/readme.md");
  expect(fileLinks(fragment)[0]?.dataset.fileFragment).toBe("details");
});
