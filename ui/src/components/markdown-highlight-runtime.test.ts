import { expect, it } from "vitest";
import { highlightCodeHtml } from "./markdown-highlight-runtime.ts";

it("leaves unlabeled fences plain instead of guessing a language from prose", () => {
  const prompt =
    "Approved to review and land your current work, carefully. If it is not on its own " +
    "worktree from origin/main, move it to one. If the publisher refuses, push with gh from the " +
    "worktree. Report the merged PR link or the exact blocker.";

  expect(highlightCodeHtml(prompt, "")).toBe(prompt);
  expect(highlightCodeHtml("def run(x):\n    return x\n", "python")).toContain("hljs-keyword");
});
