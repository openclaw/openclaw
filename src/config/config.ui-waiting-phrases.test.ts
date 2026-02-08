import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("ui.waitingPhrases", () => {
  it("accepts an array of strings", () => {
    const res = validateConfigObject({
      ui: { waitingPhrases: ["scheming", "plotting", "loitering"] },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects empty array", () => {
    const res = validateConfigObject({ ui: { waitingPhrases: [] } });
    expect(res.ok).toBe(false);
  });

  it("rejects empty strings in array", () => {
    const res = validateConfigObject({ ui: { waitingPhrases: [""] } });
    expect(res.ok).toBe(false);
  });

  it("rejects non-array values", () => {
    const res = validateConfigObject({ ui: { waitingPhrases: "noodling" } });
    expect(res.ok).toBe(false);
  });

  it("accepts single phrase", () => {
    const res = validateConfigObject({ ui: { waitingPhrases: ["vibing"] } });
    expect(res.ok).toBe(true);
  });
});
