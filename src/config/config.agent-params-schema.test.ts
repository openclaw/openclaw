import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("per-agent params schema validation (#25903)", () => {
  it("accepts params in agent entries", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "pi",
            params: { cacheRetention: "short", temperature: 0.7 },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("still rejects unknown fields in agent entries", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "pi",
            notARealField: true,
          },
        ],
      },
    });
    expect(res.ok).toBe(false);
  });
});
