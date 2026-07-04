import { afterEach, describe, expect, it, vi } from "vitest";
import { safeEqualSecret } from "./secret-equal.js";

const { timingSafeEqualSpy } = vi.hoisted(() => ({
  timingSafeEqualSpy: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

describe("safeEqualSecret", () => {
  afterEach(() => {
    timingSafeEqualSpy.mockClear();
  });

  it.each([
    ["secret-token", "secret-token", true],
    ["secret-token", "secret-tokEn", false],
    ["short", "much-longer", false],
    ["", "", true],
    ["", "secret", false],
    [undefined, "secret", false],
    ["secret", undefined, false],
    [null, "secret", false],
  ] as const)("compares %o and %o", (left, right, expected) => {
    expect(safeEqualSecret(left, right)).toBe(expected);
  });

  it("compares Unicode by exact UTF-8 bytes without normalization", () => {
    expect(safeEqualSecret("🔐秘密", "🔐秘密")).toBe(true);
    expect(safeEqualSecret("é", "e\u0301")).toBe(false);
    expect(safeEqualSecret("é", "a")).toBe(false);
  });

  it("compares unequal UTF-8 lengths through equal-length padded buffers", () => {
    expect(safeEqualSecret("é", "much-longer-秘密")).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledOnce();
    const [providedBytes, expectedBytes] = timingSafeEqualSpy.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(providedBytes)).toBe(true);
    expect(Buffer.isBuffer(expectedBytes)).toBe(true);
    expect(providedBytes).toHaveLength(expectedBytes?.byteLength ?? 0);
  });

  it("rejects unequal lengths even when zero-padding makes the compared bytes equal", () => {
    expect(safeEqualSecret("a", "a\0")).toBe(false);
    expect(timingSafeEqualSpy).toHaveReturnedWith(true);
  });

  it("rejects Buffer inputs instead of silently changing the string contract", () => {
    expect(safeEqualSecret(Buffer.from("secret") as unknown as string, "secret")).toBe(false);
    expect(safeEqualSecret("secret", Buffer.from("secret") as unknown as string)).toBe(false);
  });
});
