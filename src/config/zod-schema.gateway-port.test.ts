// Schema-level tests for gateway.port TCP range validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("gateway.port schema", () => {
  it("rejects a port above the TCP range", () => {
    const res = validateConfigObject({ gateway: { port: 65_536 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toMatch(/port/);
    }
  });

  it("rejects port 0", () => {
    const res = validateConfigObject({ gateway: { port: 0 } });
    expect(res.ok).toBe(false);
  });

  it("accepts the maximum valid port", () => {
    const res = validateConfigObject({ gateway: { port: 65_535 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.port).toBe(65_535);
    }
  });

  it("accepts a typical port", () => {
    const res = validateConfigObject({ gateway: { port: 18_789 } });
    expect(res.ok).toBe(true);
  });
});
