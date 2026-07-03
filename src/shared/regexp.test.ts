import { describe, expect, it } from "vitest";
import { escapeRegExp } from "./regexp.js";

describe("escapeRegExp", () => {
  it("returns the original string when no regex special characters are present", () => {
    expect(escapeRegExp("hello")).toBe("hello");
    expect(escapeRegExp("hello world 123")).toBe("hello world 123");
  });

  it("escapes individual regex special characters", () => {
    expect(escapeRegExp(".")).toBe("\\.");
    expect(escapeRegExp("*")).toBe("\\*");
    expect(escapeRegExp("+")).toBe("\\+");
    expect(escapeRegExp("?")).toBe("\\?");
    expect(escapeRegExp("^")).toBe("\\^");
    expect(escapeRegExp("$")).toBe("\\$");
    expect(escapeRegExp("{")).toBe("\\{");
    expect(escapeRegExp("}")).toBe("\\}");
    expect(escapeRegExp("(")).toBe("\\(");
    expect(escapeRegExp(")")).toBe("\\)");
    expect(escapeRegExp("[")).toBe("\\[");
    expect(escapeRegExp("]")).toBe("\\]");
    expect(escapeRegExp("|")).toBe("\\|");
    expect(escapeRegExp("\\")).toBe("\\\\");
  });

  it("escapes combinations of special characters", () => {
    expect(escapeRegExp("[test].*")).toBe("\\[test\\]\\.\\*");
    expect(escapeRegExp("a+b?c")).toBe("a\\+b\\?c");
    expect(escapeRegExp("${value}")).toBe("\\$\\{value\\}");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeRegExp("")).toBe("");
  });

  it("handles strings that are already partially escaped", () => {
    expect(escapeRegExp("\\.")).toBe("\\\\\\.");
    expect(escapeRegExp("\\[test\\]")).toBe("\\\\\\[test\\\\\\]");
  });

  it("escapes special characters embedded in longer text", () => {
    expect(escapeRegExp("price: $19.99 + tax?")).toBe("price: \\$19\\.99 \\+ tax\\?");
  });
});
