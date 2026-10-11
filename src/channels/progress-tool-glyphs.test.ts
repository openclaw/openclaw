import { describe, expect, it } from "vitest";
import { TOOL_DISPLAY_CONFIG } from "../agents/tool-display-config.js";
import { PROGRESS_TOOL_GLYPHS } from "./progress-tool-glyphs.js";

describe("progress tool glyphs", () => {
  it("has a text glyph for every configured tool icon", () => {
    const icons = [
      TOOL_DISPLAY_CONFIG.fallback.icon,
      ...Object.values(TOOL_DISPLAY_CONFIG.tools).map((spec) => spec.icon),
    ];
    expect(icons.filter((icon) => !PROGRESS_TOOL_GLYPHS[icon])).toEqual([]);
  });
});
