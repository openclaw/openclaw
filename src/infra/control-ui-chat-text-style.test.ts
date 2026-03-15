import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("control ui chat text styles", () => {
  it("uses conservative line-wrapping for chat messages", () => {
    const cssPath = resolve(process.cwd(), "ui/src/styles/components.css");
    const css = readFileSync(cssPath, "utf8");
    const match = css.match(/\.chat-text\s*\{[^}]*\}/m);
    expect(match?.[0]).toBeTruthy();

    const block = match?.[0] ?? "";
    expect(block).toContain("overflow-wrap: break-word;");
    expect(block).toContain("word-break: normal;");
  });
});
