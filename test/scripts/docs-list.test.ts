import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocsHeadingMap } from "../../scripts/docs-list.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { files } from "./docs-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const docsListScriptPath = path.resolve(import.meta.dirname, "../../scripts/docs-list.js");

function makeDocs(contents: Record<string, string>) {
  const root = tempDirs.make("openclaw-docs-list-");
  const docs = path.join(root, "docs");
  for (const [file, content] of Object.entries(contents)) {
    files(docs).write(file, content);
  }
  return { root, docs };
}

function runDocsList(cwd: string, args: string[] = []): string {
  return execFileSync(process.execPath, [docsListScriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("docs-list", () => {
  it("reads metadata across supported front matter forms", () => {
    const cases = [
      ["inline", "\n", 'read_when: "Read this page when the hint is inline."\n---'],
      ["yaml-end", "\n", "..."],
      ["annotated", "\r\n", "--- # end"],
      ["whitespace", "\n", "---   "],
      ["document-end-comment", "\r\n", "... # end"],
    ] as const;
    const { root } = makeDocs(
      Object.fromEntries(
        cases.map(([name, nl, end]) => [
          `${name}.md`,
          `---${nl}summary: "Summary for ${name}"${nl}${end}${nl}`,
        ]),
      ),
    );
    const output = runDocsList(root);

    for (const [name] of cases) {
      expect(output).toContain(`${name}.md - Summary for ${name}`);
    }
    expect(output).toContain("Read when: Read this page when the hint is inline.");
    expect(output).not.toContain("unterminated front matter");
  });

  it("renders the publish docs map on demand without creating a mirror", () => {
    const { root, docs } = makeDocs({
      "page.md": [
        '---\nsummary: "Page"\n# This metadata comment must not become a heading\n... # end',
        "# Visible title\n## `API[*]` <script>alert(1)</script>",
        "### <scr<script>ipt>alert(1)</script>\n#### `![label](https://example.test/image)`",
        "```md\n### Hidden fenced heading\n```",
        "````md\n```json\n### Hidden nested fenced heading\n```\n````",
        "~~~md\n### Hidden fenced heading with a suffixed closer\n~~~json",
        "### Still hidden after the invalid closer\n~~~\n# Visible after the fenced block\n",
      ].join("\n"),
      "nested/index.mdx": "# Nested\n",
      "AGENTS.md": "# Instructions\n",
    });

    const output = runDocsList(root, ["--headings"]);

    expect(output).toContain("## page.md\n\n- Route: /page");
    expect(output).toContain("  - H1: Visible title");
    expect(output).toContain("  - H2: `API[*]` &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output).toContain("  - H3: &lt;scr&lt;script&gt;ipt&gt;alert(1)&lt;/script&gt;");
    expect(output).toContain("  - H4: `![label](https://example.test/image)`");
    expect(output).toContain("## nested/index.mdx\n\n- Route: /nested");
    expect(output).not.toContain("metadata comment must not become a heading");
    expect(output).not.toContain("Hidden fenced heading");
    expect(output).not.toContain("Hidden nested fenced heading");
    expect(output).not.toContain("Still hidden after the invalid closer");
    expect(output).toContain("  - H1: Visible after the fenced block");
    expect(output).not.toContain("AGENTS.md");
    expect(existsSync(path.join(docs, "docs_map.md"))).toBe(false);
  });

  it.each([
    ["nonbreaking space", "```md", "```\u00a0\n## Still hidden\n```"],
    ["tabs", "```", "```\t\t"],
  ])("recognizes closing fences with %s", (_name, opening, closing) => {
    const { docs } = makeDocs({
      "page.md": `${opening}\n# Hidden example\n${closing}\n# Visible after close\n`,
    });
    const output = renderDocsHeadingMap(docs);

    expect(output).not.toContain("H1: Hidden example");
    expect(output).not.toContain("H2: Still hidden");
    expect(output).toContain("H1: Visible after close");
  });

  it("normalizes injected Windows paths for nested page routes", () => {
    const { docs } = makeDocs({
      "nested/index.mdx": "# Nested index\n",
      "nested/page.md": "# Nested page\n",
    });

    const output = renderDocsHeadingMap(docs, {
      relativePath: (base, fullPath) => path.relative(base, fullPath).replace(/[\\/]+/gu, "\\"),
    });

    expect(output).toContain("## nested/index.mdx\n\n- Route: /nested");
    expect(output).toContain("## nested/page.md\n\n- Route: /nested/page");
    expect(output).not.toContain("\\");
  });
});
