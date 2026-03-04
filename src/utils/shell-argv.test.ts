import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shell-argv.js";

describe("splitShellArgs", () => {
  it("splits basic whitespace-separated tokens", () => {
    expect(splitShellArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitShellArgs("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(splitShellArgs("   ")).toEqual([]);
  });

  it("handles single-quoted strings", () => {
    expect(splitShellArgs("foo 'bar baz'")).toEqual(["foo", "bar baz"]);
  });

  it("handles double-quoted strings", () => {
    expect(splitShellArgs('foo "bar baz"')).toEqual(["foo", "bar baz"]);
  });

  it("handles backslash escaping outside quotes", () => {
    expect(splitShellArgs("foo\\ bar baz")).toEqual(["foo bar", "baz"]);
  });

  it("does not interpret backslash inside single quotes", () => {
    expect(splitShellArgs("'foo\\bar'")).toEqual(["foo\\bar"]);
  });

  it("does not interpret backslash inside double quotes", () => {
    expect(splitShellArgs('"foo\\bar"')).toEqual(["foo\\bar"]);
  });

  it("handles adjacent quoted and unquoted segments", () => {
    expect(splitShellArgs("foo'bar'baz")).toEqual(["foobarbaz"]);
  });

  it("handles multiple spaces between tokens", () => {
    expect(splitShellArgs("foo   bar")).toEqual(["foo", "bar"]);
  });

  it("handles tabs and mixed whitespace", () => {
    expect(splitShellArgs("foo\tbar\t baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns null for unterminated single quote", () => {
    expect(splitShellArgs("foo 'bar")).toBeNull();
  });

  it("returns null for unterminated double quote", () => {
    expect(splitShellArgs('foo "bar')).toBeNull();
  });

  it("returns null for trailing backslash", () => {
    expect(splitShellArgs("foo\\")).toBeNull();
  });

  it("drops empty quoted strings", () => {
    expect(splitShellArgs("foo '' bar")).toEqual(["foo", "bar"]);
  });

  it("handles single token with no spaces", () => {
    expect(splitShellArgs("hello")).toEqual(["hello"]);
  });

  it("handles mixed quote styles", () => {
    expect(splitShellArgs(`"foo" 'bar' baz`)).toEqual(["foo", "bar", "baz"]);
  });
});
