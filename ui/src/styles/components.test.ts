import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssPath = fileURLToPath(new URL("./components.css", import.meta.url));

describe("cron workspace form styles", () => {
  it("keeps sticky panel scrollable on desktop", () => {
    const css = readFileSync(cssPath, "utf8");
    const block = css.match(/\.cron-workspace-form\s*\{[^}]*\}/)?.[0] ?? "";

    expect(block).toContain("position: sticky;");
    expect(block).toContain("top: 74px;");
    expect(block).toContain("max-height: calc(100vh - 90px);");
    expect(block).toContain("overflow-y: auto;");
    expect(block).toContain("overscroll-behavior: contain;");
    expect(css).toContain("@supports (height: 100dvh)");
    expect(css).toContain("max-height: calc(100dvh - 90px);");
  });

  it("disables panel scrolling in mobile layout", () => {
    const css = readFileSync(cssPath, "utf8");
    const media = css.match(/@media \(max-width: 1100px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(media).toContain(".cron-workspace-form {");
    expect(media).toContain("position: static;");
    expect(media).toContain("order: -1;");
    expect(media).toContain("max-height: none;");
    expect(media).toContain("overflow: visible;");
  });
});
