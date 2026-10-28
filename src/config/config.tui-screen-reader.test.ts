import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("ui.tui.screenReader config", () => {
  it.each([true, false])("accepts and preserves screenReader=%s", (screenReader) => {
    const result = validateConfigObject({ ui: { tui: { screenReader } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.ui?.tui?.screenReader).toBe(screenReader);
    }
  });

  it("loads an existing ui config without the tui block unchanged", () => {
    const ui = { seamColor: "#FF8800", prefs: { theme: "claw", themeMode: "dark" } };
    const result = validateConfigObject({ ui });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.ui).toEqual(ui);
    }
  });

  it.each([
    { value: "true" },
    { value: 1 },
    { value: { screenReader: true, extra: true } },
    { value: { typo: true } },
  ])("rejects invalid ui.tui payload %j", ({ value }) => {
    const result = validateConfigObject({ ui: { tui: value } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("ui.tui"))).toBe(true);
    }
  });
});
