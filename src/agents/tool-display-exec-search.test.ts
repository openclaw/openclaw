import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

const cases = [
  ["rg --files autonomy .openclaw 2>/dev/null", "rg --files .openclaw"],
  ["rg --files -g '*.ts'", "rg --files"],
  ["rg --files -t ts src", "rg --files src"],
  ["rg --files --glob=*.ts src", "rg --files src"],
  ["rg -- --files src", "rg -e --files src"],
  ["rg -e --files src", "rg -e --files src"],
  ["rg needle src 2>/dev/null", "rg needle src"],
  ["rg needle src 2> /dev/null", "rg needle src"],
  ["rg needle src>/dev/null", "rg needle src"],
  ["rg needle src 2>&1", "rg needle src"],
  ["rg needle src >|out", "rg needle src"],
  ["rg '2>/dev/null' README.md", "rg '2>/dev/null' README.md"],
  [String.raw`rg 2\>literal README.md`, "rg '2>literal' README.md"],
  ["rg -e needle src", "rg needle src"],
  ["rg -ne'needle' src", "rg needle src"],
  ["rg -f patterns src", "search text in src"],
  ["grep -E -e needle src", "grep needle src"],
  ["rg -E utf8 needle src", "rg needle src"],
  ["cat >out <<EOF\nsynthetic body\nEOF", "cat"],
  ["head -n 2 source > out", "head -n 2 source"],
  ["cp 2>err source destination", "copy source to destination"],
  ["tail source 2>&1", "tail source"],
] as const;

describe("exec search and redirect display", () => {
  it.each(cases)("summarizes %s", (command, expected) => {
    expect(
      formatToolDetail(
        resolveToolDisplay({ name: "exec", args: { command }, detailMode: "explain" }),
      ),
    ).toBe(expected);
  });
  it("preserves the original command in raw detail mode", () => {
    const command = "rg needle src 2> /dev/null";
    const detail = formatToolDetail(
      resolveToolDisplay({ name: "bash", args: { command }, detailMode: "raw" }),
    );
    expect(detail).toContain("rg needle src");
    expect(detail).toContain(command);
  });
});
