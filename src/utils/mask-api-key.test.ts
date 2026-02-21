import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("returns trimmed value when length is 16 chars or less", () => {
    expect(maskApiKey(" abcdefghijklmnop ")).toBe("abcdefghijklmnop");
    expect(maskApiKey(" short ")).toBe("short");
  });

  it("masks long values with first and last 8 chars", () => {
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("12345678...ijklmnop");
  });
});
