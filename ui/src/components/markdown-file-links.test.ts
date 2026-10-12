// Workspace file links share rendering across transcript and sidebar Markdown.
import { describe, expect, it, vi } from "vitest";
import { shortestFileLabels } from "./file-kind.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function render(source: string, options: MarkdownRenderOptions = { fileLinks: true }) {
  return htmlFragment(toSanitizedMarkdownHtml(source, options));
}

function fileLinks(fragment: ParentNode) {
  return [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
}

describe("file links", () => {
  it("links multi-segment paths only when enabled", () => {
    const enabled = render("see src/lib/foo.ts for details");
    const link = enabled.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe("src/lib/foo.ts");
    expect(link?.hasAttribute("href")).toBe(false);

    const disabled = render("see src/lib/foo.ts and src/lib/foo.ts:42 for details", {});
    expect(disabled.querySelector("a[data-file-path]")).toBeNull();
  });

  it.each([
    ["plain text", "see src/lib/foo.ts:42"],
    ["inline code", "`src/lib/foo.ts:42`"],
    ["explicit Markdown", "[source](src/lib/foo.ts:42)"],
  ])("makes %s workspace file links keyboard-focusable without adding an href", (_kind, input) => {
    const fragment = render(input);
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");

    expect(link?.getAttribute("role")).toBe("button");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.hasAttribute("href")).toBe(false);
    document.body.append(fragment);
    link?.focus();
    expect(document.activeElement).toBe(link);
    fragment.remove();
  });

  it.each<[string, string[], string[]]>([
    [
      "~/notes.md ./x.ts ../y.ts foo.ts inventory.csv",
      ["~/notes.md", "./x.ts", "../y.ts"],
      ["foo.ts", "inventory.csv"],
    ],
    ["rotated logs/app.log.1 but see src/lib/foo.ts.", ["src/lib/foo.ts"], ["logs/app.log.1"]],
    [
      "bumped 1.1/1.2 and `2026.9.2`, see v1.2/3.4 [part](assets/part.3mf)",
      ["assets/part.3mf"],
      [],
    ],
    [
      "`src/lib/foo.ts` `navigation.ts` `inventory.csv` `foo.bar()` `notes.xyz123`",
      ["src/lib/foo.ts", "navigation.ts", "inventory.csv"],
      ["foo.bar()", "notes.xyz123"],
    ],
    [
      "`re\u0301sume\u0301.md` and `C:\\文档\\café.md:9`",
      ["re\u0301sume\u0301.md", "C:\\文档\\café.md"],
      [],
    ],
    [
      "`café note.md` `emoji-🌱.md` `100% ready.txt` `reader's [draft] (v2).md` Read the notes/readme.md now.",
      ["notes/readme.md"],
      [],
    ],
    ...["./portal.example/service.test", ".config/workflows/check.yml", "src.v2/app.ts"].map(
      (path): [string, string[], string[]] => [path, [path], []],
    ),
  ])("recognizes workspace paths while preserving prose in %s", (input, paths, preserved) => {
    const fragment = render(input);
    expect(fileLinks(fragment).map((link) => link.dataset.filePath)).toEqual(paths);
    expect(fragment.querySelectorAll("a[data-file-path]")).toHaveLength(paths.length);
    for (const text of preserved) {
      expect(fragment.textContent).toContain(text);
    }
  });

  it.each<[string, { path: string; line: string; label?: string }[]]>([
    [
      "src/lib/foo.ts:42 and bar.ts:7:3",
      [
        { path: "src/lib/foo.ts", line: "42", label: "foo.ts:42" },
        { path: "bar.ts", line: "7", label: "bar.ts:7:3" },
      ],
    ],
    [
      "`src/commands/auth-choice-options.static.ts:26-35`",
      [{ path: "src/commands/auth-choice-options.static.ts", line: "26" }],
    ],
  ])("preserves line suffixes and targets their first line in %s", (input, expected) => {
    expect(
      fileLinks(render(input)).map((link) => ({
        path: link.dataset.filePath,
        line: link.dataset.fileLine,
        label: link.textContent,
      })),
    ).toMatchObject(expected);
  });

  it("links Windows absolute paths", () => {
    const fragment = render("C:/repo/src/foo.ts:42 and `D:\\work\\bar.ts`");
    const links = fileLinks(fragment);
    expect(links.map((link) => link.dataset.filePath)).toEqual([
      "C:/repo/src/foo.ts",
      "D:\\work\\bar.ts",
    ]);
    expect(links[0]?.dataset.fileLine).toBe("42");
  });

  it("converts explicit relative and absolute local file links", () => {
    const fragment = render("[foo.ts](src/utils/foo.ts:42) [x](/Users/a/b.ts)");
    const links = fileLinks(fragment);
    expect(links).toHaveLength(2);
    expect(links[0]?.dataset).toMatchObject({
      filePath: "src/utils/foo.ts",
      fileLine: "42",
    });
    expect(links[1]?.dataset.filePath).toBe("/Users/a/b.ts");
    expect(links.every((link) => !link.hasAttribute("href"))).toBe(true);

    const disabled = render("[x](/Users/a/b.ts)", {});
    expect(disabled.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(disabled.querySelector("a")?.hasAttribute("data-file-path")).toBe(false);
  });

  it.each(["inventory.CSV", "inventory report.csv"])(
    "opens authored CSV destination %s as a workspace file instead of navigating",
    (path) => {
      const markdown = `[Read inventory](${encodeURI(path)})`;
      const fragment = render(markdown);
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.dataset.filePath).toBe(path);
      expect(link?.textContent).toBe("Read inventory");
      expect(link?.getAttribute("role")).toBe("button");
      expect(link?.getAttribute("tabindex")).toBe("0");
      expect(link?.hasAttribute("href")).toBe(false);

      const disabled = render(markdown, {});
      expect(disabled.querySelector("a[data-file-path]")).toBeNull();
      expect(disabled.querySelector("a")?.getAttribute("href")).toBe(encodeURI(path));
    },
  );

  it.each(["文档/说明.md", "qa-cafe\u0301/re\u0301sume\u0301.md", "notes/２０２６.md"])(
    "preserves Unicode workspace path %s across Markdown forms",
    (path) => {
      for (const markdown of [
        `[Read file](${path}:17)`,
        `[Read file](${encodeURI(path)}:17)`,
        `\`${path}:17\``,
        `Inspect ${path}:17 now.`,
      ]) {
        const fragment = render(markdown);
        const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
        expect(link?.dataset).toMatchObject({ filePath: path, fileLine: "17" });
        expect(link?.getAttribute("role")).toBe("button");
        expect(link?.hasAttribute("href")).toBe(false);
        if (markdown.startsWith("[")) {
          expect(link?.textContent).toBe("Read file");
        }
      }
    },
  );

  it.each(["family-👩‍👩‍👧.md", "100% ready.txt", "reader's [draft] (v2).md", "literal%20name.txt"])(
    "preserves authored filename %s without treating its punctuation as prose",
    (name) => {
      for (const path of [name, `qa files/${name}`]) {
        for (const suffix of ["", ":17"]) {
          const fragment = render(`[Read file](${encodeURI(path)}${suffix})`);
          const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
          expect(link?.dataset.filePath).toBe(path);
          expect(link?.dataset.fileLine).toBe(suffix ? "17" : undefined);
          expect(link?.textContent).toBe("Read file");
          expect(link?.hasAttribute("href")).toBe(false);
        }
      }
    },
  );

  it("keeps authored URL and session destinations out of workspace file handling", () => {
    const destinations = [
      "https://example.com/caf%C3%A9%20note.md",
      "//example.com/emoji-%F0%9F%8C%B1.md",
      "notes/readme.md?raw=1",
      "notes/readme.md#intro",
      "/chat/main/notes/readme.md",
      "https://example.com/inventory.csv",
      "//example.com/inventory.csv",
      "inventory.csv?download=1",
      "inventory.csv#totals",
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

  it.each([
    "portal.example/service.test",
    "docs.example.dev/guide.md:42",
    "münich.de/guide.md",
    "example.xn--p1ai/guide.md",
  ])("never treats the domain/path reference %s as a workspace file", (reference) => {
    for (const input of [reference, `\`${reference}\``, `[website](${reference})`]) {
      const fragment = render(input);
      expect(fragment.querySelector("a[data-file-path]")).toBeNull();
      expect(fragment.textContent?.trim()).toBe(input.startsWith("[") ? "website" : reference);
    }
  });

  it("does not link paths inside fenced code blocks", () => {
    const fragment = render("```ts\nsrc/lib/foo.ts:42\n```");
    expect(fragment.querySelector("a[data-file-path]")).toBeNull();
    expect(fragment.querySelector("code")?.textContent).toContain("src/lib/foo.ts:42");
  });

  it.each<[string, { path?: string; line?: string; label?: string; title?: string | null }[]]>([
    [
      "see src/components/Button.tsx for details",
      [
        {
          path: "src/components/Button.tsx",
          label: "Button.tsx",
          title: "src/components/Button.tsx",
        },
      ],
    ],
    ["`README.md`", [{ label: "README.md", title: null }]],
    [
      "[src/lib/foo.ts](src/lib/foo.ts) and [go](src/lib/bar.ts)",
      [{ title: null }, { title: "src/lib/bar.ts" }],
    ],
    [
      "`src/lib/foo.ts` and [the button](src/ui/Button.tsx:12)",
      [
        { label: "foo.ts", title: "src/lib/foo.ts" },
        { label: "the button", title: "src/ui/Button.tsx:12" },
      ],
    ],
    [
      "ui/src/app.ts and api/src/app.ts and `D:\\work\\app.ts`",
      [{ label: "ui/src/app.ts" }, { label: "api/src/app.ts" }, { label: "work\\app.ts" }],
    ],
    ...[
      "/tmp/qa/src/file.ts:7 and tmp/qa/src/file.ts:7",
      "`/tmp/qa/src/file.ts:7` and `tmp/qa/src/file.ts:7`",
    ].map((input): [string, { path: string; line: string; label: string }[]] => [
      input,
      [
        { path: "/tmp/qa/src/file.ts", line: "7", label: "/tmp/qa/src/file.ts:7" },
        { path: "tmp/qa/src/file.ts", line: "7", label: "tmp/qa/src/file.ts:7" },
      ],
    ]),
  ])("keeps file labels unambiguous and tooltips nonredundant in %s", (input, expected) => {
    expect(
      fileLinks(render(input)).map((link) => ({
        path: link.dataset.filePath,
        line: link.dataset.fileLine,
        label: link.textContent,
        title: link.getAttribute("title"),
      })),
    ).toMatchObject(expected);
  });

  it("keeps per-path lookup cost linear as path count grows (performance contract)", () => {
    // The pre-fix full-list rescan (#124230) used O(n^2) Map lookups.
    // Count operations instead of timing work under variable CI load.
    const countMapLookups = (pathCount: number): number => {
      const paths = Array.from(
        { length: pathCount },
        (_, i) => `src/pkg${i % 50}/mod${i}/file${i}.ts`,
      );
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
    ["`skills/review/other-skill.md`", "skills/review/other-skill.md", "markdown"],
    ["`package.json`", "package.json", "package"],
    ["`src/components/Button.tsx`", "src/components/Button.tsx", "component"],
    ["`notes/todo.txt`", "notes/todo.txt", "file"],
    ["[Read file](/tmp/constructor)", "/tmp/constructor", "file"],
    ["[Read file](/tmp/notes.__proto__)", "/tmp/notes.__proto__", "file"],
    ["skills/review/SKILL.md:12", "skills/review/SKILL.md", "skill", "12"],
    ["[Review skill](skills/review/SKILL.md:12)", "skills/review/SKILL.md", "skill", "12"],
  ])("classifies %s without changing workspace navigation", (input, path, kind, line) => {
    const link = render(input).querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe(path);
    expect(link?.dataset.fileKind).toBe(kind);
    expect(link?.dataset.fileLine).toBe(line);
    expect(link?.getAttribute("role")).toBe("button");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("keeps GitHub-hosted skill files owned by the external-link renderer", () => {
    const url = "https://github.com/openclaw/openclaw/blob/main/skills/github/SKILL.md";
    const fragment = render(`[Skill](${url})`);
    const link = fragment.querySelector<HTMLAnchorElement>("a");
    expect(link?.classList.contains("markdown-github-link")).toBe(true);
    expect(link?.hasAttribute("data-file-kind")).toBe(false);
    expect(link?.getAttribute("href")).toBe(url);
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
});
