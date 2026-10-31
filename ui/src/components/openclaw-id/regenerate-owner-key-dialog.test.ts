import { describe, expect, it } from "vitest";
import { regenerationExpiry } from "./regenerate-owner-key-dialog.tsx";

describe("regenerationExpiry", () => {
  const now = Date.UTC(2026, 9, 31, 12);

  it("means no expiry when the field is empty", () => {
    expect(regenerationExpiry("", now)).toBeNull();
    expect(regenerationExpiry("  ", now)).toBeNull();
  });

  it("turns whole days into Unix seconds from now", () => {
    expect(regenerationExpiry("7", now)).toBe(now / 1000 + 7 * 86_400);
  });

  it("rejects anything that is not a positive whole number of days", () => {
    for (const text of ["0", "-1", "1.5", "soon"]) {
      expect(regenerationExpiry(text, now)).toBeUndefined();
    }
  });
});
