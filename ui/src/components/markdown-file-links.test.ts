// Workspace file links share rendering across transcript and sidebar Markdown.
import { describe, expect, it, vi } from "vitest";
import { shortestFileLabels } from "./file-kind.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("file links", () => {
  it("links multi-segment paths only when enabled", () => {
    const enabled = htmlFragment(
      toSanitizedMarkdownHtml("see src/lib/foo.ts for details", { fileLinks: true }),
    );
    const link = enabled.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe("src/lib/foo.ts");
    expect(link?.hasAttribute("href")).toBe(false);

    const disabled = htmlFragment(
      toSanitizedMarkdownHtml("see src/lib/foo.ts and src/lib/foo.ts:42 for details"),
    );
    expect(disabled.querySelector("a[data-file-path]")).toBeNull();
  });

  it.each([
    ["plain text", "see src/lib/foo.ts:42"],
    ["inline code", "`src/lib/foo.ts:42`"],
    ["explicit Markdown", "[source](src/lib/foo.ts:42)"],
  ])("makes %s workspace file links keyboard-focusable without adding an href", (_kind, input) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");

    expect(link?.getAttribute("role")).toBe("button");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.hasAttribute("href")).toBe(false);
    document.body.append(fragment);
    link?.focus();
    expect(document.activeElement).toBe(link);
    fragment.remove();
  });

  it("links prefixed single-segment paths but not bare prose filenames", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("~/notes.md ./x.ts ../y.ts foo.ts inventory.csv", {
        fileLinks: true,
      }),
    );
    expect(
      [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")].map(
        (link) => link.dataset.filePath,
      ),
    ).toEqual(["~/notes.md", "./x.ts", "../y.ts"]);
    expect(fragment.textContent).toContain("foo.ts");
    expect(fragment.textContent).toContain("inventory.csv");
  });

  it("keeps line suffixes on the label while storing the parsed line", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("src/lib/foo.ts:42 and bar.ts:7:3", { fileLinks: true }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links[0]?.dataset.filePath).toBe("src/lib/foo.ts");
    expect(links[0]?.dataset.fileLine).toBe("42");
    expect(links[0]?.textContent).toBe("foo.ts:42");
    expect(links[1]?.dataset.filePath).toBe("bar.ts");
    expect(links[1]?.dataset.fileLine).toBe("7");
    expect(links[1]?.textContent).toBe("bar.ts:7:3");
  });

  it("targets the first line of a range suffix", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("`src/commands/auth-choice-options.static.ts:26-35`", {
        fileLinks: true,
      }),
    );
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe("src/commands/auth-choice-options.static.ts");
    expect(link?.dataset.fileLine).toBe("26");
  });

  it("does not link a shorter prefix of a numeric-suffix filename", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("rotated logs/app.log.1 but see src/lib/foo.ts.", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a[data-file-path]")];
    expect(links.map((link) => link.dataset.filePath)).toEqual(["src/lib/foo.ts"]);
    expect(fragment.textContent).toContain("logs/app.log.1");
  });

  it("does not link dotted version numbers but keeps authored digit-led extensions", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(
        "bumped 1.1/1.2 and `2026.9.2`, see v1.2/3.4 [part](assets/part.3mf)",
        {
          fileLinks: true,
        },
      ),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a[data-file-path]")];
    expect(links.map((link) => link.dataset.filePath)).toEqual(["assets/part.3mf"]);
  });

  it("links Windows absolute paths", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("C:/repo/src/foo.ts:42 and `D:\\work\\bar.ts`", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links.map((link) => link.dataset.filePath)).toEqual([
      "C:/repo/src/foo.ts",
      "D:\\work\\bar.ts",
    ]);
    expect(links[0]?.dataset.fileLine).toBe("42");
  });

  it("links inline-code paths and conservative bare filenames", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(
        "`src/lib/foo.ts` `navigation.ts` `inventory.csv` `foo.bar()` `notes.xyz123`",
        {
          fileLinks: true,
        },
      ),
    );
    expect(
      [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")].map(
        (link) => link.dataset.filePath,
      ),
    ).toEqual(["src/lib/foo.ts", "navigation.ts", "inventory.csv"]);
    expect(fragment.textContent).toContain("foo.bar()");
    expect(fragment.textContent).toContain("notes.xyz123");
  });

  it("converts explicit relative and absolute local file links", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("[foo.ts](src/utils/foo.ts:42) [x](/Users/a/b.ts)", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links).toHaveLength(2);
    expect(links[0]?.dataset).toMatchObject({
      filePath: "src/utils/foo.ts",
      fileLine: "42",
    });
    expect(links[1]?.dataset.filePath).toBe("/Users/a/b.ts");
    expect(links.every((link) => !link.hasAttribute("href"))).toBe(true);

    const disabled = htmlFragment(toSanitizedMarkdownHtml("[x](/Users/a/b.ts)"));
    expect(disabled.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(disabled.querySelector("a")?.hasAttribute("data-file-path")).toBe(false);
  });

  it.each(["inventory.csv", "./inventory.csv", "inventory.CSV", "inventory report.csv"])(
    "opens authored CSV destination %s as a workspace file instead of navigating",
    (path) => {
      const markdown = `[Read inventory](${encodeURI(path)})`;
      const fragment = htmlFragment(toSanitizedMarkdownHtml(markdown, { fileLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.dataset.filePath).toBe(path);
      expect(link?.textContent).toBe("Read inventory");
      expect(link?.getAttribute("role")).toBe("button");
      expect(link?.getAttribute("tabindex")).toBe("0");
      expect(link?.hasAttribute("href")).toBe(false);

      const disabled = htmlFragment(toSanitizedMarkdownHtml(markdown));
      expect(disabled.querySelector("a[data-file-path]")).toBeNull();
      expect(disabled.querySelector("a")?.getAttribute("href")).toBe(encodeURI(path));
    },
  );

  it.each([
    "qa-café/index.md",
    "文档/说明.md",
    "qa-cafe\u0301/re\u0301sume\u0301.md",
    "notes/２０２６.md",
  ])("preserves Unicode workspace path %s across Markdown forms", (path) => {
    for (const markdown of [
      `[Read file](${path}:17)`,
      `[Read file](${encodeURI(path)}:17)`,
      `\`${path}:17\``,
      `Inspect ${path}:17 now.`,
    ]) {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(markdown, { fileLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.dataset).toMatchObject({ filePath: path, fileLine: "17" });
      expect(link?.getAttribute("role")).toBe("button");
      expect(link?.hasAttribute("href")).toBe(false);
      if (markdown.startsWith("[")) {
        expect(link?.textContent).toBe("Read file");
      }
    }
  });

  it("recognizes Unicode bare and Windows filenames without normalizing their spelling", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("`re\u0301sume\u0301.md` and `C:\\文档\\café.md:9`", {
        fileLinks: true,
      }),
    );
    expect(
      [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")].map(
        (link) => link.dataset.filePath,
      ),
    ).toEqual(["re\u0301sume\u0301.md", "C:\\文档\\café.md"]);
  });

  it.each([
    "café note.md",
    "emoji-🌱.md",
    "family-👩‍👩‍👧.md",
    "100% ready.txt",
    "日本語.txt",
    "reader's [draft] (v2).md",
    "literal%20name.txt",
  ])("preserves authored filename %s without treating its punctuation as prose", (name) => {
    for (const path of [name, `qa files/${name}`]) {
      for (const suffix of ["", ":17"]) {
        const fragment = htmlFragment(
          toSanitizedMarkdownHtml(`[Read file](${encodeURI(path)}${suffix})`, {
            fileLinks: true,
          }),
        );
        const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
        expect(link?.dataset.filePath).toBe(path);
        expect(link?.dataset.fileLine).toBe(suffix ? "17" : undefined);
        expect(link?.textContent).toBe("Read file");
        expect(link?.hasAttribute("href")).toBe(false);
      }
    }
  });

  it("keeps code and prose filename scanning conservative", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(
        "`café note.md` `emoji-🌱.md` `100% ready.txt` `reader's [draft] (v2).md` Read the notes/readme.md now.",
        { fileLinks: true },
      ),
    );
    expect(
      [...fragment.querySelectorAll("a[data-file-path]")].map((link) =>
        link.getAttribute("data-file-path"),
      ),
    ).toEqual(["notes/readme.md"]);
  });

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
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(destinations.map((href) => `[Read](${href})`).join("\n"), {
        fileLinks: true,
        sessionLinks: true,
      }),
    );
    expect(fragment.querySelector("a[data-file-path]")).toBeNull();
    expect([...fragment.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(
      destinations,
    );
  });

  it("leaves http links as normal links", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("https://example.com/a/b.ts", { fileLinks: true }),
    );
    const link = fragment.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("https://example.com/a/b.ts");
    expect(link?.hasAttribute("data-file-path")).toBe(false);
  });

  it.each([
    "portal.example/service.test",
    "example.com/src/app.ts",
    "docs.example.dev/guide.md:42",
    "example.ai/config.json?raw=1",
    "münich.de/guide.md",
    "example.xn--p1ai/guide.md",
  ])("never treats the domain/path reference %s as a workspace file", (reference) => {
    for (const input of [reference, `\`${reference}\``, `[website](${reference})`]) {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
      expect(fragment.querySelector("a[data-file-path]")).toBeNull();
      expect(fragment.textContent?.trim()).toBe(input.startsWith("[") ? "website" : reference);
    }
  });

  it.each([
    "./portal.example/service.test",
    "../example.com/src/app.ts",
    "~/example.com/guide.md",
    "/example.com/guide.md",
    "C:/example.com/guide.md",
    ".config/workflows/check.yml",
    "src/components.v2/Button.tsx",
    "src.v2/app.ts",
  ])("keeps the local path %s addressable", (path) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(path, { fileLinks: true }));
    expect(fragment.querySelector<HTMLAnchorElement>("a[data-file-path]")?.dataset.filePath).toBe(
      path,
    );
  });

  it("does not link paths inside fenced code blocks", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("```ts\nsrc/lib/foo.ts:42\n```", { fileLinks: true }),
    );
    expect(fragment.querySelector("a[data-file-path]")).toBeNull();
    expect(fragment.querySelector("code")?.textContent).toContain("src/lib/foo.ts:42");
  });

  it("guards common prose false positives", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("Node.js, e.g. version 1.2.3", { fileLinks: true }),
    );
    expect(fragment.querySelector("a[data-file-path]")).toBeNull();
  });

  it("labels a file link with its basename and keeps the path addressable", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("see src/components/Button.tsx for details", { fileLinks: true }),
    );
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.textContent).toBe("Button.tsx");
    expect(link?.dataset.filePath).toBe("src/components/Button.tsx");
    expect(link?.getAttribute("title")).toBe("src/components/Button.tsx");
  });

  it("adds no tooltip when the label is already the whole reference", () => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml("`README.md`", { fileLinks: true }));
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.textContent).toBe("README.md");
    expect(link?.hasAttribute("title")).toBe(false);
  });

  it("adds no tooltip when an explicit label already repeats the reference", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("[src/lib/foo.ts](src/lib/foo.ts) and [go](src/lib/bar.ts)", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links.map((link) => link.getAttribute("title"))).toEqual([null, "src/lib/bar.ts"]);
  });

  it("shortens inline-code paths and keeps author labels on explicit links", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("`src/lib/foo.ts` and [the button](src/ui/Button.tsx:12)", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links.map((link) => link.textContent)).toEqual(["foo.ts", "the button"]);
    expect(links.map((link) => link.getAttribute("title"))).toEqual([
      "src/lib/foo.ts",
      "src/ui/Button.tsx:12",
    ]);
  });

  it("grows the label only far enough to tell equal basenames apart", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("ui/src/app.ts and api/src/app.ts and `D:\\work\\app.ts`", {
        fileLinks: true,
      }),
    );
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    // The Windows path is unique one segment up, so it stops there while the
    // other two grow to three — and it keeps its own separator.
    expect(links.map((link) => link.textContent)).toEqual([
      "ui/src/app.ts",
      "api/src/app.ts",
      "work\\app.ts",
    ]);
  });

  it.each([
    ["plain text", "/tmp/qa/src/file.ts:7 and tmp/qa/src/file.ts:7"],
    ["inline code", "`/tmp/qa/src/file.ts:7` and `tmp/qa/src/file.ts:7`"],
  ])("keeps absolute and relative file labels distinct in %s", (_kind, input) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
    const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
    expect(links.map((link) => link.dataset.filePath)).toEqual([
      "/tmp/qa/src/file.ts",
      "tmp/qa/src/file.ts",
    ]);
    expect(links.map((link) => link.dataset.fileLine)).toEqual(["7", "7"]);
    expect(links.map((link) => link.textContent)).toEqual([
      "/tmp/qa/src/file.ts:7",
      "tmp/qa/src/file.ts:7",
    ]);
  });

  it("keeps labels correct and distinct across thousands of paths", () => {
    // A model-controlled message can reference thousands of distinct files.
    // The regression this guards against is quadratic label derivation, so
    // this pairs an all-unique-basename set (no repeated suffix growth)
    // with a colliding-basename set (forced suffix growth) at the same
    // cardinality; both must resolve correctly, not just quickly.
    const distinctPaths = Array.from(
      { length: 4000 },
      (_, i) => `src/pkg${i % 50}/mod${i}/file${i}.ts`,
    );
    const distinctLabels = shortestFileLabels(distinctPaths);
    expect(distinctLabels.size).toBe(distinctPaths.length);
    for (const path of distinctPaths) {
      expect(distinctLabels.get(path)).toBe(path.slice(path.lastIndexOf("/") + 1));
    }

    const collidingPaths = Array.from({ length: 4000 }, (_, i) => `pkg${i}/shared/index.ts`);
    const collidingLabels = shortestFileLabels(collidingPaths);
    expect(collidingLabels.size).toBe(collidingPaths.length);
    expect(new Set(collidingLabels.values()).size).toBe(collidingPaths.length);
    for (const path of collidingPaths) {
      expect(collidingLabels.get(path)).toBe(path);
    }
  });

  it("keeps per-path lookup cost linear as path count grows (performance contract)", () => {
    // Wall-clock timing flakes under CI load, so this asserts the actual
    // performance contract structurally: count every Map#get call made while
    // shortestFileLabels runs. The trie makes a fixed number of child
    // lookups per path segment (one per segment on insert, one per resolved
    // suffix depth on lookup), so total lookups scale with path count, not
    // its square. The pre-fix full-list rescan (#124230) re-read every other
    // path's segments inside `unique.some(...)` at every depth, which cost
    // O(n^2) lookups for this same all-unique-basename shape -- 8x the paths
    // there costs ~64x the lookups, far outside the linear band asserted
    // below, so a regression back to that scan fails this test every run.
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

  it.each([
    ["README.md", "markdown"],
    ["SKILL.md", "skill"],
    ["skills/review/skill.MD", "skill"],
    ["C:\\skills\\review\\SKILL.md", "skill"],
    ["skills/review/SKILL.markdown", "markdown"],
    ["skills/review/other-skill.md", "markdown"],
    ["package.json", "package"],
    ["src/components/Button.tsx", "component"],
    ["src/index.ts", "code"],
    ["config/app.yaml", "data"],
    ["scripts/run.sh", "shell"],
    ["docs/logo.png", "image"],
    ["notes/todo.txt", "file"],
    // Inline code so bare filenames link too: the prose scan deliberately
    // ignores them unless they carry a directory or a line suffix.
  ])("classifies %s as the %s glyph kind", (path, kind) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(`\`${path}\``, { fileLinks: true }));
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe(path);
    expect(link?.dataset.fileKind).toBe(kind);
  });

  it.each([
    "skills/review/SKILL.md:12",
    "`skills/review/SKILL.md:12`",
    "[Review skill](skills/review/SKILL.md:12)",
  ])("uses the skill kind without changing file navigation for %s", (input) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.fileKind).toBe("skill");
    expect(link?.dataset.filePath).toBe("skills/review/SKILL.md");
    expect(link?.dataset.fileLine).toBe("12");
    expect(link?.getAttribute("role")).toBe("button");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("keeps GitHub-hosted skill files owned by the external-link renderer", () => {
    const url = "https://github.com/openclaw/openclaw/blob/main/skills/github/SKILL.md";
    const fragment = htmlFragment(toSanitizedMarkdownHtml(`[Skill](${url})`, { fileLinks: true }));
    const link = fragment.querySelector<HTMLAnchorElement>("a");
    expect(link?.classList.contains("markdown-github-link")).toBe(true);
    expect(link?.hasAttribute("data-file-kind")).toBe(false);
    expect(link?.getAttribute("href")).toBe(url);
  });

  it.each([
    ["spaces", "see docs/my notes.md today"],
    ["parentheses", "see src/lib/foo(1).ts today"],
    ["a fragment", "see README.md#install today"],
    ["a query", "see config.json?raw=1 today"],
  ])("never pulls %s into a file path, and leaves the prose intact", (_kind, input) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
    for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")) {
      expect(link.dataset.filePath).not.toMatch(/[\s()?]/);
    }
    expect(fragment.textContent).toContain(input);
  });
});
