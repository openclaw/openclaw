// Covers gateway.port TCP range validation (issue #109293).
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("gateway.port TCP range", () => {
  it.each([1, 18789, 65_535])("accepts port %i", (port) => {
    const result = validateConfigObject({ gateway: { port } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.port).toBe(port);
    }
  });

  it.each([0, 65_536, 100_000])("rejects port %i as out of range", (port) => {
    const result = validateConfigObject({ gateway: { port } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "gateway.port")).toBe(true);
    }
  });
});
