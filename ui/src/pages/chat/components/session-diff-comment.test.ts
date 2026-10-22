/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { readDiffCommentSelection } from "./session-diff-comment.ts";

beforeEach(() => window.getSelection()?.removeAllRanges());

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

it("extracts selected code without gutters and preserves deleted-file coordinates", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<div>7 −<span data-comment-line="7" data-comment-side="old">return <b>3</b>;</span></div><div>8 −<span data-comment-line="8" data-comment-side="old">done();</span></div>';
  document.body.append(root);
  const cells = root.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(cells[0]!, 0);
  range.setEnd(cells[1]!, cells[1]!.childNodes.length);
  window.getSelection()?.addRange(range);
  expect(readDiffCommentSelection(root, "new.ts", "old.ts")?.selection).toEqual({
    text: "return 3;\ndone();",
    start: 0,
    end: 17,
    file: { path: "old.ts", startLine: 7, endLine: 8, side: "old" },
  });
});

it.each(["revision", "gap"])("does not mislabel a selection crossing a %s boundary", (boundary) => {
  const root = document.createElement("div");
  root.innerHTML =
    '<span data-comment-line="7" data-comment-side="old">old</span><span data-comment-line="' +
    (boundary === "gap" ? "10" : "8") +
    '" data-comment-side="' +
    (boundary === "gap" ? "old" : "new") +
    '">other</span>';
  document.body.append(root);
  const range = document.createRange();
  range.selectNodeContents(root);
  window.getSelection()?.addRange(range);
  expect(readDiffCommentSelection(root, "file.ts")).toBeUndefined();
});
