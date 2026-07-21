import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

describe("GatewayConfigSchema port validation", () => {
  it("accepts a valid gateway port (1–65535)", () => {
    const result = GatewayConfigSchema.safeParse({ port: 8080 });
    expect(result.success).toBe(true);
    if (result.success) {
      // GatewayConfigSchema is optional at the top level, so data may be undefined.
      expect(result.data?.port).toBe(8080);
    }
  });

  it("accepts port 1 (minimum valid TCP port)", () => {
    const result = GatewayConfigSchema.safeParse({ port: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts port 65535 (maximum valid TCP port)", () => {
    const result = GatewayConfigSchema.safeParse({ port: 65535 });
    expect(result.success).toBe(true);
  });

  it("rejects port 0 (below TCP range)", () => {
    const result = GatewayConfigSchema.safeParse({ port: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects port 65536 (above TCP range)", () => {
    const result = GatewayConfigSchema.safeParse({ port: 65536 });
    expect(result.success).toBe(false);
  });

  it("rejects negative port values", () => {
    const result = GatewayConfigSchema.safeParse({ port: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer port values", () => {
    const result = GatewayConfigSchema.safeParse({ port: 8080.5 });
    expect(result.success).toBe(false);
  });
});
