// Plugin documentation example tests validate plugin snippets from docs.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listMarkdownFiles(): string[] {
  const files = expectNoReaddirSyncDuring(() => listGitTrackedFiles({ pathspecs: "docs/plugins" }));
  if (!files) {
    throw new Error("Could not list tracked plugin docs");
  }
  const markdownFiles = files.filter((filePath) => filePath.endsWith(".md"));
  expect(markdownFiles.length).toBeGreaterThan(0);
  return markdownFiles.map((filePath) => path.join(process.cwd(), filePath));
}

describe("plugin docs examples", () => {
  it("keeps plugin docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const docPath of listMarkdownFiles()) {
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const lang = match[1] ?? "";
        const code = match[2] ?? "";
        const relativePath = toRepoRelativePath(process.cwd(), docPath);
        const location = `${relativePath}:${lineNumberAt(markdown, match.index ?? 0)}`;
        try {
          if (lang === "json") {
            JSON.parse(code);
          } else {
            JSON5.parse(code);
          }
        } catch (error) {
          failures.push(`${location} ${lang.toUpperCase()} parse failed: ${String(error)}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });
});
