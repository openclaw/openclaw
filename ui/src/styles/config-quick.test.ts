import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./config-quick.css", import.meta.url), "utf8");

describe("config-quick styles", () => {
  it("includes the local user identity quick-settings styles", () => {
    expect(css).toContain(".qs-identity-grid");
    expect(css).toContain(".qs-assistant-avatar");
    expect(css).toContain(".qs-user-avatar");
    expect(css).toContain(".qs-personal-actions");
  });

  it("includes the stacked quick-settings density layout", () => {
    expect(css).toContain(".qs-stack");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(css).toContain("@media (max-width: 1380px)");
  });

  it("includes explicit context profile layout hooks", () => {
    expect(css).toContain(".qs-profiles");
    expect(css).toContain(".qs-profile-state--pending");
    expect(css).toContain(".qs-profile-panel__actions-row");
  });

  it("avoids transition-all in the quick settings surface", () => {
    expect(css).not.toContain("transition: all");
  });
});
