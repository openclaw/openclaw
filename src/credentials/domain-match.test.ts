import { describe, expect, it } from "vitest";
import { isDomainAllowed, isSelectorAllowed } from "./domain-match.js";

describe("isDomainAllowed", () => {
  it("allows exact domain match", () => {
    const result = isDomainAllowed("https://accounts.google.com/login", ["accounts.google.com"]);
    expect(result).toEqual({
      allowed: true,
      hostname: "accounts.google.com",
      matchedDomain: "accounts.google.com",
    });
  });

  it("allows exact domain with different case", () => {
    const result = isDomainAllowed("https://Accounts.Google.COM/path", ["accounts.google.com"]);
    expect(result.allowed).toBe(true);
  });

  it("rejects non-matching domain", () => {
    const result = isDomainAllowed("https://evil.com/fake-login", ["accounts.google.com"]);
    expect(result).toEqual({ allowed: false, hostname: "evil.com" });
  });

  it("allows wildcard *.example.com for sub.example.com", () => {
    const result = isDomainAllowed("https://sub.example.com/page", ["*.example.com"]);
    expect(result.allowed).toBe(true);
    expect(result.matchedDomain).toBe("*.example.com");
  });

  it("allows wildcard *.example.com for deep.sub.example.com", () => {
    const result = isDomainAllowed("https://deep.sub.example.com/x", ["*.example.com"]);
    expect(result.allowed).toBe(true);
  });

  it("rejects wildcard *.example.com for bare example.com (subdomains only)", () => {
    const result = isDomainAllowed("https://example.com", ["*.example.com"]);
    expect(result.allowed).toBe(false);
  });

  it("allows shorthand .example.com same as *.example.com", () => {
    const result = isDomainAllowed("https://sub.example.com", [".example.com"]);
    expect(result.allowed).toBe(true);
  });

  it("rejects when no pinned domains match", () => {
    const result = isDomainAllowed("https://evil.com", ["google.com", "github.com"]);
    expect(result.allowed).toBe(false);
    expect(result.hostname).toBe("evil.com");
  });

  it("handles invalid URL gracefully", () => {
    const result = isDomainAllowed("not-a-url", ["example.com"]);
    expect(result.allowed).toBe(false);
    expect(result.hostname).toBe("not-a-url");
  });

  it("handles URL with port", () => {
    const result = isDomainAllowed("https://accounts.google.com:443/login", [
      "accounts.google.com",
    ]);
    expect(result.allowed).toBe(true);
  });

  it("handles URL with path and query", () => {
    const result = isDomainAllowed("https://github.com/login?return_to=%2F", ["github.com"]);
    expect(result.allowed).toBe(true);
  });

  it("returns matched domain in result", () => {
    const result = isDomainAllowed("https://app.example.com", ["other.com", "*.example.com"]);
    expect(result.matchedDomain).toBe("*.example.com");
  });

  it("matches first applicable domain when multiple match", () => {
    const result = isDomainAllowed("https://accounts.google.com", [
      "accounts.google.com",
      "*.google.com",
    ]);
    expect(result.matchedDomain).toBe("accounts.google.com");
  });

  it("rejects empty pinned domains list", () => {
    const result = isDomainAllowed("https://example.com", []);
    expect(result.allowed).toBe(false);
  });

  it("skips empty strings in pinned domains", () => {
    const result = isDomainAllowed("https://example.com", ["", "example.com"]);
    expect(result.allowed).toBe(true);
  });
});

describe("isSelectorAllowed", () => {
  it("allows any selector when allowedSelectors is undefined", () => {
    expect(isSelectorAllowed("#password", undefined)).toBe(true);
  });

  it("allows any selector when allowedSelectors is empty", () => {
    expect(isSelectorAllowed("#password", [])).toBe(true);
  });

  it("allows matching selector", () => {
    expect(isSelectorAllowed("#password", ["#password", "input[type=password]"])).toBe(true);
  });

  it("rejects non-matching selector", () => {
    expect(isSelectorAllowed("#username", ["#password"])).toBe(false);
  });

  it("matches exact selector string", () => {
    expect(isSelectorAllowed("input[type=password]", ["input[type=password]"])).toBe(true);
  });
});
