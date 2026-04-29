import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("config styles", () => {
  it("keeps touch-primary config text controls large enough to avoid iOS focus zoom", () => {
    const css = readFileSync(path.join(process.cwd(), "ui/src/styles/config.css"), "utf8");

    expect(css).toContain("@media (hover: none) and (pointer: coarse)");
    for (const selector of [
      ".config-search__input",
      ".settings-theme-import__input",
      ".config-raw-field textarea",
      ".cfg-input",
      ".cfg-input--sm",
      ".cfg-textarea",
      ".cfg-textarea--sm",
      ".cfg-number__input",
      ".cfg-select",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("font-size: 16px;");
  });
});
