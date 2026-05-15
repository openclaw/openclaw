import { describe, expect, it } from "vitest";
import { sanitizeUrlInput } from "./sanitize-url.js";

describe("sanitizeUrlInput", () => {
  it("strips special-token prefix with quotes and pipes", () => {
    expect(sanitizeUrlInput('<<|"|https://example.com/path')).toBe("https://example.com/path");
  });

  it("strips angle/pipe tag wrapper before scheme", () => {
    expect(sanitizeUrlInput("<|something|>https://a.b/c")).toBe("https://a.b/c");
  });

  it("strips a leading quote", () => {
    expect(sanitizeUrlInput('"https://x.y')).toBe("https://x.y");
  });

  it("trims leading whitespace before http scheme", () => {
    expect(sanitizeUrlInput("   http://x")).toBe("http://x");
  });

  it("leaves a clean URL untouched", () => {
    expect(sanitizeUrlInput("https://normal.com")).toBe("https://normal.com");
  });

  it("leaves a non-URL string untouched so existing error paths fire", () => {
    expect(sanitizeUrlInput("not-a-url")).toBe("not-a-url");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeUrlInput("")).toBe("");
  });
});
