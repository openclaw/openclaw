import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("masks short keys without revealing any characters", () => {
    expect(maskApiKey(" short ")).toBe("****");
    expect(maskApiKey(" a ")).toBe("****");
    expect(maskApiKey(" ab ")).toBe("****");
    expect(maskApiKey("12345678")).toBe("****");
  });

  it("masks longer keys with only first 4 characters", () => {
    expect(maskApiKey("123456789")).toBe("1234****");
    expect(maskApiKey(" abcdefghijklmnop ")).toBe("abcd****");
    expect(maskApiKey("sk-ant-api03-abcdefghijklmnop")).toBe("sk-a****");
  });
});
