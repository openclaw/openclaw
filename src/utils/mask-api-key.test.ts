import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("always masks keys showing only first 4 chars", () => {
    expect(maskApiKey(" abcdefghijklmnop ")).toBe("abcd****");
    expect(maskApiKey(" short ")).toBe("shor****");
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("1234****");
  });
});
