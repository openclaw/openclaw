import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("masks short and medium values without returning raw secrets", () => {
    expect(maskApiKey(" abcdefghijklmnop ")).toBe("****");
    expect(maskApiKey(" short ")).toBe("****");
    expect(maskApiKey(" a ")).toBe("****");
    expect(maskApiKey(" ab ")).toBe("****");
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("****");
  });

  it("masks all configured values with a fixed mask", () => {
    expect(maskApiKey("a")).toBe("****");
    expect(maskApiKey("ab")).toBe("****");
  });
});
