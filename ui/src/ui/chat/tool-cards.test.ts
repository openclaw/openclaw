import { describe, expect, it } from "vitest";
import { buildToolSidebarContent } from "./tool-cards.ts";

describe("tool-cards", () => {
  it("includes full command and formatted output when tool output exists", () => {
    const content = buildToolSidebarContent({
      label: "Terminal",
      detail: "python very-long-command --flag value",
      text: '{"ok":true}',
    });

    expect(content).toContain("## Terminal");
    expect(content).toContain("**Command:** `python very-long-command --flag value`");
    expect(content).toContain("```json");
    expect(content).toContain('"ok": true');
  });

  it("renders completion text when output is empty", () => {
    const content = buildToolSidebarContent({
      label: "Terminal",
      detail: "run npm test",
      text: "   ",
    });

    expect(content).toContain("## Terminal");
    expect(content).toContain("**Command:** `run npm test`");
    expect(content).toContain("No output — tool completed successfully.");
  });
});
