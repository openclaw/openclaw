import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns 'missing' for empty or whitespace-only values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("returns masked placeholder for any non-empty key", () => {
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("****");
  });
});
