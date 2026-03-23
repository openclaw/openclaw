import { describe, expect, it } from "vitest";
import { generateSecureToken, generateSecureUuid } from "./secure-random.js";

describe("secure-random", () => {
  it("generates UUIDs", () => {
    const first = generateSecureUuid();
    const second = generateSecureUuid();
    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generates url-safe tokens", () => {
    const defaultToken = generateSecureToken();
    const token18 = generateSecureToken(18);
    expect(defaultToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token18).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
