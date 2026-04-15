import { describe, expect, it } from "vitest";
import { isTwitterStatusUrl, rewriteToFxTwitterApi } from "./web-fetch-twitter.js";

describe("isTwitterStatusUrl", () => {
  it("matches twitter.com status URLs", () => {
    expect(isTwitterStatusUrl(new URL("https://twitter.com/elonmusk/status/1234567890"))).toBe(
      true,
    );
  });

  it("matches x.com status URLs", () => {
    expect(isTwitterStatusUrl(new URL("https://x.com/user/status/9876543210"))).toBe(true);
  });

  it("matches www.twitter.com", () => {
    expect(isTwitterStatusUrl(new URL("https://www.twitter.com/user/status/123"))).toBe(true);
  });

  it("rejects non-status twitter URLs", () => {
    expect(isTwitterStatusUrl(new URL("https://twitter.com/user"))).toBe(false);
    expect(isTwitterStatusUrl(new URL("https://twitter.com/explore"))).toBe(false);
  });

  it("rejects non-twitter URLs", () => {
    expect(isTwitterStatusUrl(new URL("https://example.com/user/status/123"))).toBe(false);
  });
});

describe("rewriteToFxTwitterApi", () => {
  it("rewrites twitter.com to api.fxtwitter.com", () => {
    expect(rewriteToFxTwitterApi(new URL("https://twitter.com/user/status/123"))).toBe(
      "https://api.fxtwitter.com/user/status/123",
    );
  });

  it("rewrites x.com to api.fxtwitter.com", () => {
    expect(rewriteToFxTwitterApi(new URL("https://x.com/user/status/456"))).toBe(
      "https://api.fxtwitter.com/user/status/456",
    );
  });

  it("returns null for non-twitter URLs", () => {
    expect(rewriteToFxTwitterApi(new URL("https://example.com/user/status/123"))).toBeNull();
  });

  it("returns null for non-status twitter URLs", () => {
    expect(rewriteToFxTwitterApi(new URL("https://twitter.com/explore"))).toBeNull();
  });
});
