import { describe, expect, it } from "vitest";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
  it("returns an array", () => {
    const updates = resolveTelegramAllowedUpdates();
    expect(Array.isArray(updates)).toBe(true);
  });

  it("includes message_reaction", () => {
    const updates = resolveTelegramAllowedUpdates();
    expect(updates).toContain("message_reaction");
  });

  it("includes default update types", () => {
    const updates = resolveTelegramAllowedUpdates();
    expect(updates).toContain("message");
  });

  it("returns same result on repeated calls", () => {
    const a = resolveTelegramAllowedUpdates();
    const b = resolveTelegramAllowedUpdates();
    expect(a).toEqual(b);
  });
});
