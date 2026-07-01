// Tests for CLI argument quoting helper.
import { describe, expect, it } from "vitest";
import { quoteCliArg } from "./quote-cli-arg.js";

describe("quoteCliArg", () => {
  it("returns safe string unchanged", () => {
    expect(quoteCliArg("hello")).toBe("hello");
  });

  it("returns path with slashes unchanged", () => {
    expect(quoteCliArg("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("wraps string with spaces", () => {
    expect(quoteCliArg("hello world")).toBe("'hello world'");
  });

  it("escapes single quote", () => {
    expect(quoteCliArg("it's")).toBe("'it'\\''s'");
  });

  it("returns empty string unchanged", () => {
    expect(quoteCliArg("")).toBe("");
  });

  it("wraps string with dollar sign", () => {
    expect(quoteCliArg("$PATH")).toBe("'$PATH'");
  });
});
