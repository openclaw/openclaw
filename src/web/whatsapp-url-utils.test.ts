import { describe, expect, it } from "vitest";
import { stripMarkdownFromUrls } from "./whatsapp-url-utils.js";

describe("stripMarkdownFromUrls", () => {
  it("removes bold markdown from URLs", () => {
    const input = "Check this **https://example.com** out";
    const expected = "Check this https://example.com out";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("removes bold-italic markdown from URLs", () => {
    const input = "Visit ***https://example.com*** today";
    const expected = "Visit https://example.com today";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("removes underscore bold from URLs", () => {
    const input = "Link: __https://example.com__";
    const expected = "Link: https://example.com";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("removes italic markdown from URLs", () => {
    const input = "Click *https://example.com* now";
    const expected = "Click https://example.com now";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("removes underscore italic from URLs", () => {
    const input = "See _https://example.com_ for details";
    const expected = "See https://example.com for details";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("converts markdown link syntax to plain URLs", () => {
    const input = "[Click here](https://example.com)";
    const expected = "https://example.com";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("handles multiple URLs in same text", () => {
    const input = "Check **https://example.com** and [visit](https://other.com)";
    const expected = "Check https://example.com and https://other.com";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("preserves text without markdown", () => {
    const input = "Visit https://example.com for more info";
    expect(stripMarkdownFromUrls(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripMarkdownFromUrls("")).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    expect(stripMarkdownFromUrls("")).toBe("");
  });

  it("preserves https protocol", () => {
    const input = "**https://example.com**";
    expect(stripMarkdownFromUrls(input)).toContain("https://");
  });

  it("handles URLs with query parameters", () => {
    const input = "**https://example.com?param=value&other=123**";
    const expected = "https://example.com?param=value&other=123";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("handles URLs with fragments", () => {
    const input = "[docs](https://example.com#section)";
    const expected = "https://example.com#section";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("handles http protocol URLs", () => {
    const input = "*http://example.com*";
    const expected = "http://example.com";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });

  it("doesn't remove markdown from non-URLs", () => {
    const input = "This is **bold text** and *italic*";
    expect(stripMarkdownFromUrls(input)).toBe(input);
  });

  it("handles complex real-world example", () => {
    const input = "For help, see [our docs](https://docs.example.com) or email **support@example.com** - check *https://status.example.com* for updates";
    const expected = "For help, see https://docs.example.com or email **support@example.com** - check https://status.example.com for updates";
    expect(stripMarkdownFromUrls(input)).toBe(expected);
  });
});
