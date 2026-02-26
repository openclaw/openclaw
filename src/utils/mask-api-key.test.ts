import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("always returns masked placeholder", () => {
    expect(maskApiKey("")).toBe("****");
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("****");
  });
});
