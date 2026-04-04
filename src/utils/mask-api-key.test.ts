import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns 'missing' for empty string", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("masks short keys (length <= 6)", () => {
    expect(maskApiKey("abc")).toBe("a...c");
    expect(maskApiKey("12345")).toBe("1...5");
    expect(maskApiKey("123456")).toBe("1...6");
  });

  it("masks medium keys (7-16 chars)", () => {
    expect(maskApiKey("abcdefg")).toBe("ab...fg");
    expect(maskApiKey("1234567890123456")).toBe("12...56");
  });

  it("masks long keys (> 16 chars)", () => {
    const long = "abcdefghijklmnop";
    expect(maskApiKey(long)).toBe("abcdefgh...mnop");
  });

  it("handles exact boundary lengths", () => {
    expect(maskApiKey("123456")).toBe("1...6"); // <= 6
    expect(maskApiKey("1234567")).toBe("12...67"); // <= 16
  });

  it("handles single character", () => {
    expect(maskApiKey("x")).toBe("x...x");
  });

  it("handles two characters", () => {
    expect(maskApiKey("ab")).toBe("a...b");
  });

  it("trims whitespace", () => {
    expect(maskApiKey("  abc  ")).toBe("a...c");
  });
});
