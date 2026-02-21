import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("skills entries config schema", () => {
  it("accepts custom fields under config", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            enabled: true,
            config: {
              url: "https://example.invalid",
              token: "abc123",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts arbitrary top-level fields on a skill entry (passthrough)", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            url: "https://example.invalid",
            host: "api.example.com",
            defaultWarehouseId: "wh-1",
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }
    const entry = res.data.skills?.entries?.["custom-skill"] as Record<string, unknown>;
    expect(entry?.url).toBe("https://example.invalid");
    expect(entry?.host).toBe("api.example.com");
    expect(entry?.defaultWarehouseId).toBe("wh-1");
  });
});
