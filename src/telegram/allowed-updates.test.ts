import { describe, expect, it } from "vitest";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
  it("includes poll_answer updates", () => {
    const updates = resolveTelegramAllowedUpdates();
    expect(updates).toContain("poll_answer");
  });
});
