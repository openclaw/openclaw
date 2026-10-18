// Validates session.fallbackNameNouns at the config-validation boundary.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("session.fallbackNameNouns", () => {
  it.each([undefined, []])("accepts %j and leaves default naming in place", (nouns) => {
    const res = validateConfigObject({ session: { fallbackNameNouns: nouns } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.session?.fallbackNameNouns ?? []).toEqual([]);
    }
  });

  it("deduplicates valid nouns in order", () => {
    const res = validateConfigObject({
      session: { fallbackNameNouns: ["falcon", "otter", "falcon", "badger", "otter"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.session?.fallbackNameNouns).toEqual(["falcon", "otter", "badger"]);
    }
  });

  it.each(["", "Otter", "sea-otter", "sea otter", "otter2", "otter_", "\u00e9meu", "a".repeat(21)])(
    "rejects %j with a path to the bad entry",
    (noun) => {
      const res = validateConfigObject({ session: { fallbackNameNouns: ["falcon", noun] } });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toContainEqual(
          expect.objectContaining({
            path: "session.fallbackNameNouns.1",
            message: expect.stringContaining("one lowercase ASCII word"),
          }),
        );
      }
    },
  );
});
