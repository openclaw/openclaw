import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuidv7.js";

describe("uuidv7", () => {
  it("generates a valid UUID format", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  it("embeds version 7", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7");
  });

  it("embeds variant 10xx", () => {
    const id = uuidv7();
    const variantChar = id[19];
    expect(["8", "9", "a", "b"]).toContain(variantChar);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(uuidv7());
    }
    expect(ids.size).toBe(100);
  });

  it("IDs are roughly time-ordered", () => {
    const a = uuidv7();
    const b = uuidv7();
    // Same millisecond or later — lexicographic comparison works for UUIDv7
    expect(a <= b || a.slice(0, 8) === b.slice(0, 8)).toBe(true);
  });
});
