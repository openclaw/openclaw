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

  it("wraps empty string in quotes", () => {
    expect(quoteCliArg("")).toBe("''");
  });

  it("wraps string with dollar sign", () => {
    expect(quoteCliArg("$PATH")).toBe("'$PATH'");
  });

  it("wraps string with ampersand", () => {
    expect(quoteCliArg("build & run")).toBe("'build & run'");
  });

  it("wraps string with pipe", () => {
    expect(quoteCliArg("cat file | grep x")).toBe("'cat file | grep x'");
  });

  it("wraps string with glob wildcard", () => {
    expect(quoteCliArg("*.txt")).toBe("'*.txt'");
  });
});
