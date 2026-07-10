import { describe, expect, it } from "vitest";
import { maskApiKey } from "./secret-mask.js";

describe("maskApiKey", () => {
  it.each([
    ["", "missing"],
    ["   ", "missing"],
    [" short ", "s...t"],
    [" a ", "a...a"],
    [" ab ", "a...b"],
    [" abcdefghijklmnop ", "ab...op"],
    ["1234567890abcdefghijklmnop", "12345678...ijklmnop"],
  ])("masks %o", (value, expected) => {
    expect(maskApiKey(value)).toBe(expected);
  });

  it("strips control characters before applying the display policy", () => {
    expect(maskApiKey("abcd\nefghijklmnop")).toBe("ab...op");
    expect(maskApiKey("abcd\u0000efghijklmnop")).toBe("ab...op");
    expect(maskApiKey("abcd\u007f\u0085efghijklmnop")).toBe("ab...op");
    expect(maskApiKey("\u0000\n")).toBe("missing");
  });

  it("preserves the existing UTF-16 code-unit slicing contract", () => {
    expect(maskApiKey("😀")).toBe("\ud83d...\ude00");
    expect(maskApiKey("😀abcdefghijklmno😀")).toBe("😀abcdef...jklmno😀");
  });
});
