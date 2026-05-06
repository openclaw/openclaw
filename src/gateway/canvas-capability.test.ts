import { describe, expect, test } from "vitest";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";

describe("normalizeCanvasScopedUrl", () => {
  test("marks malformed request targets without throwing", () => {
    for (const rawUrl of ["//", "///", "//${jndi:ldap://example}.action"]) {
      expect(() => normalizeCanvasScopedUrl(rawUrl)).not.toThrow();
      expect(normalizeCanvasScopedUrl(rawUrl)).toMatchObject({
        malformedScopedPath: true,
        scopedPath: false,
      });
    }
  });
});
