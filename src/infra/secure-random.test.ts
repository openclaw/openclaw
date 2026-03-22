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

  it("generates url-safe tokens with the default byte count", () => {
    cryptoMocks.randomBytes.mockClear();

    const defaultToken = generateSecureToken();

    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(16);
    expect(defaultToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(defaultToken).toHaveLength(Buffer.alloc(16, 0xab).toString("base64url").length);
  });

  it("passes custom byte counts through to crypto.randomBytes", () => {
    cryptoMocks.randomBytes.mockClear();

    const token18 = generateSecureToken(18);

    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(18);
    expect(token18).toBe(Buffer.alloc(18, 0xab).toString("base64url"));
  });

  it("supports zero-byte tokens without rewriting the requested size", () => {
    cryptoMocks.randomBytes.mockClear();

    const token = generateSecureToken(0);

    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(0);
    expect(token).toBe("");
  });
});
