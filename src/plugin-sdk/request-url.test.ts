import { describe, expect, it } from "vitest";
import { resolveRequestUrl } from "./request-url.js";

describe("resolveRequestUrl", () => {
  it("resolves string input", () => {
    expect(resolveRequestUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("resolves URL input", () => {
    expect(resolveRequestUrl(new URL("https://example.com/b"))).toBe("https://example.com/b");
  });

  it("resolves object input with url field", () => {
    const requestLike = { url: "https://example.com/c" } as unknown as RequestInfo;
    expect(resolveRequestUrl(requestLike)).toBe("https://example.com/c");
  });
});
