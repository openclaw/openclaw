import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("masks short keys (<=4 chars) with first 1 char only", () => {
    expect(maskApiKey("a")).toBe("a...");
    expect(maskApiKey("ab")).toBe("a...");
    expect(maskApiKey("abcd")).toBe("a...");
    expect(maskApiKey(" short ")).toBe("shor...");
  });

  it("masks longer keys with first 4 chars only", () => {
    expect(maskApiKey("abcdefghijklmnop")).toBe("abcd...");
    expect(maskApiKey("sk-ant-api03-abcxyz1234")).toBe("sk-a...");
  });

  it("never exposes the last 8 characters of the key", () => {
    const key = "sk-ant-api03-abcdefghWXYZ5678"; // pragma: allowlist secret
    const lastEight = key.slice(-8);
    const masked = maskApiKey(key);
    expect(masked).not.toContain(lastEight);
    // Also verify no tail chars leak individually beyond position 4
    for (const char of key.slice(4)) {
      if (!key.slice(0, 4).includes(char)) {
        expect(masked).not.toContain(char);
      }
    }
  });

  it("trims whitespace before masking", () => {
    expect(maskApiKey("  sk-ant-api03-abc  ")).toBe("sk-a...");
  });
});
