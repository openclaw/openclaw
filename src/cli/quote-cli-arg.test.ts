// Tests for CLI argument shell-quoting helper.
import { describe, expect, it } from "vitest";
import { quoteCliArg } from "./quote-cli-arg.js";

describe("quoteCliArg", () => {
  it.each([
    { input: "hello", expected: "hello", reason: "plain word" },
    { input: "hello-world", expected: "hello-world", reason: "with hyphen" },
    { input: "hello_world", expected: "hello_world", reason: "with underscore" },
    { input: "path/to/file", expected: "path/to/file", reason: "with slash" },
    { input: "key=value", expected: "key=value", reason: "with equals" },
    { input: "user@host", expected: "user@host", reason: "with at-sign" },
    { input: "100%", expected: "100%", reason: "with percent" },
    { input: "a+b", expected: "a+b", reason: "with plus" },
    { input: "v1.2.3", expected: "v1.2.3", reason: "with dots" },
    { input: "a,b,c", expected: "a,b,c", reason: "with commas" },
    { input: "HelloWorld", expected: "HelloWorld", reason: "mixed case" },
    { input: "123", expected: "123", reason: "digits only" },
  ])("returns unquoted '$input' ($reason)", ({ input, expected }) => {
    expect(quoteCliArg(input)).toBe(expected);
  });

  it.each([
    { input: "hello world", expected: "'hello world'", reason: "contains space" },
    { input: "foo$bar", expected: "'foo$bar'", reason: "contains dollar" },
    { input: "foo&bar", expected: "'foo&bar'", reason: "contains ampersand" },
    { input: "foo|bar", expected: "'foo|bar'", reason: "contains pipe" },
    { input: "foo;bar", expected: "'foo;bar'", reason: "contains semicolon" },
    { input: "foo<bar", expected: "'foo<bar'", reason: "contains less-than" },
    { input: "foo>bar", expected: "'foo>bar'", reason: "contains greater-than" },
    { input: "foo*bar", expected: "'foo*bar'", reason: "contains asterisk" },
    { input: "foo?bar", expected: "'foo?bar'", reason: "contains question" },
    { input: "foo(bar)", expected: "'foo(bar)'", reason: "contains parens" },
    { input: 'foo"bar', expected: "'foo\"bar'", reason: "contains double-quote" },
    { input: "foo`bar", expected: "'foo`bar'", reason: "contains backtick" },
    { input: "foo\\bar", expected: "'foo\\bar'", reason: "contains backslash" },
    { input: "foo[bar]", expected: "'foo[bar]'", reason: "contains brackets" },
    { input: "foo{bar}", expected: "'foo{bar}'", reason: "contains braces" },
    { input: "foo!bar", expected: "'foo!bar'", reason: "contains exclamation" },
    { input: "foo#bar", expected: "'foo#bar'", reason: "contains hash" },
    { input: "foo~bar", expected: "'foo~bar'", reason: "contains tilde" },
    { input: "foo^bar", expected: "'foo^bar'", reason: "contains caret" },
  ])("quotes '$input' ($reason)", ({ input, expected }) => {
    expect(quoteCliArg(input)).toBe(expected);
  });

  it("escapes single quotes", () => {
    expect(quoteCliArg("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(quoteCliArg("it's a test'")).toBe("'it'\\''s a test'\\'''");
  });

  it("returns empty quoted string for empty input", () => {
    expect(quoteCliArg("")).toBe("''");
  });
});
