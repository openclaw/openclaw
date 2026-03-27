import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn((bytes: number) => Buffer.alloc(bytes, 0xab)),
  randomUUID: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
  randomUUID: cryptoMocks.randomUUID,
}));

let generateSecureToken: typeof import("./secure-random.js").generateSecureToken;
let generateSecureUuid: typeof import("./secure-random.js").generateSecureUuid;

beforeEach(async () => {
  vi.resetModules();
  ({ generateSecureToken, generateSecureUuid } = await import("./secure-random.js"));
});

describe("secure-random", () => {
  it("delegates UUID generation to crypto.randomUUID", () => {
    cryptoMocks.randomUUID.mockReturnValueOnce("uuid-1").mockReturnValueOnce("uuid-2");

    expect(generateSecureUuid()).toBe("uuid-1");
    expect(generateSecureUuid()).toBe("uuid-2");
    expect(cryptoMocks.randomUUID).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "uses the default byte count",
      byteCount: undefined,
      expectedBytes: 16,
      expectedToken: Buffer.alloc(16, 0xab).toString("base64url"),
    },
    {
      name: "passes custom byte counts through",
      byteCount: 18,
      expectedBytes: 18,
      expectedToken: Buffer.alloc(18, 0xab).toString("base64url"),
    },
    {
      name: "supports zero-byte tokens",
      byteCount: 0,
      expectedBytes: 0,
      expectedToken: "",
    },
  ])("generates url-safe tokens when $name", ({ byteCount, expectedBytes, expectedToken }) => {
    cryptoMocks.randomBytes.mockClear();

    const token = byteCount === undefined ? generateSecureToken() : generateSecureToken(byteCount);

    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(expectedBytes);
    expect(token).toBe(expectedToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]*$/);
  });
});
