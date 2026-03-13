import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("reserved agent ID validation", () => {
  it('rejects "_shared" as an agent ID', () => {
    const res = validateConfigObject({
      agents: {
        list: [{ id: "_shared" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => /reserved/i.test(i.message))).toBe(true);
    }
  });

  it("accepts normal agent IDs", () => {
    const res = validateConfigObject({
      agents: {
        list: [{ id: "my-agent" }],
      },
    });
    expect(res.ok).toBe(true);
  });
});
