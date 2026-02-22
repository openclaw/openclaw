import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { SafeContainer } from "./safe-container.js";

describe("SafeContainer", () => {
  it("truncates lines that exceed the given width", () => {
    const container = new SafeContainer();
    const width = 10;

    // Inject a line that exceeds width via a child component
    container.addChild({
      render: () => ["a".repeat(15)],
      get height() {
        return 1;
      },
    });

    const lines = container.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
  });

  it("passes through lines within width unchanged", () => {
    const container = new SafeContainer();
    const width = 20;
    const text = "hello world";

    container.addChild({
      render: () => [text],
      get height() {
        return 1;
      },
    });

    const lines = container.render(width);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(text);
  });

  it("truncates CJK text that exceeds width by 1 column", () => {
    const container = new SafeContainer();
    const width = 10;
    // 9 ASCII chars + 1 CJK char (2 columns wide) = 11 visible columns
    const cjkLine = "a".repeat(9) + "\u4e16";

    container.addChild({
      render: () => [cjkLine],
      get height() {
        return 1;
      },
    });

    const lines = container.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
  });

  it("truncates ANSI-styled text that exceeds width", () => {
    const container = new SafeContainer();
    const width = 10;
    // Bold ANSI escape: \x1b[1m ... \x1b[0m
    const styledText = `\x1b[1m${"x".repeat(15)}\x1b[0m`;

    container.addChild({
      render: () => [styledText],
      get height() {
        return 1;
      },
    });

    const lines = container.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
  });
});
