import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("config-quick personal identity styles", () => {
  it("includes the local user identity quick-settings styles", () => {
    const css = readFileSync(new URL("./config-quick.css", import.meta.url), "utf8");

    expect(css).toContain(".qs-personal-preview");
    expect(css).toContain(".qs-user-avatar");
    expect(css).toContain(".qs-personal-actions");
  });
});
