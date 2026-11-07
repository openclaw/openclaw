import { describe, expect, it } from "vitest";
import { REPORT_BUG_URL, SUGGEST_FEATURE_URL } from "./product-links.ts";

describe("public issue form destinations", () => {
  it.each([
    [REPORT_BUG_URL, "bug_report.yml", "[Bug]: Control UI: "],
    [SUGGEST_FEATURE_URL, "feature_request.yml", "[Feature]: Control UI: "],
  ])("contains only a fixed template and title: %s", (href, template, title) => {
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("https://github.com/openclaw/openclaw/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({ template, title });
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.hash).toBe("");
  });
});
