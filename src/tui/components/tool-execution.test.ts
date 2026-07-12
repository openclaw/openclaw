import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { ToolExecutionComponent } from "./tool-execution.js";

describe("ToolExecutionComponent", () => {
  it("truncates an over-wide title+args header to the render width instead of wrapping", () => {
    const width = 80;
    const result = { content: [{ type: "text", text: "ok" }] };
    const short = new ToolExecutionComponent("read", { path: "/tmp/short" });
    short.setResult(result);
    const long = new ToolExecutionComponent("read", {
      path: `/tmp/${"deeply-nested-".repeat(60)}file.txt`,
    });
    long.setResult(result);

    const longLines = long.render(width);
    for (const line of longLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    // The header owns exactly one row in the condensed card: an over-wide
    // title+args line must truncate, never wrap into extra rows.
    expect(longLines.length).toBe(short.render(width).length);
  });
});
