import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function parseGuard(guard: unknown) {
  return OpenClawSchema.safeParse({ skills: { guard } });
}

describe("zod-schema: skills.guard", () => {
  it("accepts a valid guard config", () => {
    const result = parseGuard({
      enabled: true,
      trustedStores: [{ name: "Official", url: "https://store.example.com/api/v1/skill-guard" }],
      sideloadPolicy: "block-critical",
      syncIntervalSeconds: 300,
      auditLog: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts minimal guard config (empty object)", () => {
    const result = parseGuard({});
    expect(result.success).toBe(true);
  });

  it("accepts guard with multiple stores", () => {
    const result = parseGuard({
      trustedStores: [
        { url: "https://store1.example.com/api/v1/skill-guard" },
        { name: "Private", url: "https://store2.internal.com/api/v1/skill-guard", apiKey: "key" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects store without url", () => {
    const result = parseGuard({
      trustedStores: [{ name: "Missing URL" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown sideloadPolicy", () => {
    const result = parseGuard({ sideloadPolicy: "yolo" });
    expect(result.success).toBe(false);
  });

  it("rejects syncIntervalSeconds below 10", () => {
    const result = parseGuard({ syncIntervalSeconds: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in guard (strict)", () => {
    const result = parseGuard({ unknownField: true });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in store config (strict)", () => {
    const result = parseGuard({
      trustedStores: [{ url: "https://example.com", foo: "bar" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts skills config without guard (backward compat)", () => {
    const result = OpenClawSchema.safeParse({
      skills: {
        allowBundled: ["web-search"],
      },
    });
    expect(result.success).toBe(true);
  });
});
