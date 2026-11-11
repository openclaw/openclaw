import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

function validate(presentation: Record<string, unknown>) {
  return ModelsConfigSchema.safeParse({
    providers: {
      workstation: {
        baseUrl: "https://models.example.com/v1",
        models: [],
        ...presentation,
      },
    },
  });
}

describe("provider presentation configuration", () => {
  it("preserves identity while accepting names and each configured artwork source", () => {
    for (const icon of [
      { source: "file", path: "icons/workstation.png" },
      { source: "url", url: "https://images.example.com/icon.png" },
      { source: "builtin", name: "server" },
    ]) {
      const result = validate({ name: "  Workstation  ", icon });
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues));
      }
      expect(result.data?.providers?.workstation).toMatchObject({
        name: "Workstation",
        icon,
        baseUrl: "https://models.example.com/v1",
        models: [],
      });
      expect(Object.keys(result.data?.providers ?? {})).toEqual(["workstation"]);
    }
  });

  it("rejects unsafe URLs, malformed icons, and empty or oversized names", () => {
    for (const presentation of [
      { name: " " },
      { name: "x".repeat(101) },
      { icon: { source: "file", path: " " } },
      { icon: { source: "builtin", name: " " } },
      { icon: { source: "file", path: "icon.png", url: "https://example.com" } },
      ...[
        "http://example.com/icon.png",
        "file:///icon.png",
        "https://user:pass@example.com/icon.png",
        "https://example.com/icon.png#fragment",
      ].map((url) => ({ icon: { source: "url", url } })),
    ]) {
      expect(validate(presentation).success, JSON.stringify(presentation)).toBe(false);
    }
    expect(validate({}).success).toBe(true);
  });
});
