import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shell-argv.js";

describe("splitShellArgs", () => {
  it("splits plain whitespace-separated words", () => {
    expect(splitShellArgs("a b c")).toEqual(["a", "b", "c"]);
    expect(splitShellArgs("  hello   world  ")).toEqual(["hello", "world"]);
  });

  it("preserves single-quoted text literally", () => {
    expect(splitShellArgs("echo 'hello world'")).toEqual(["echo", "hello world"]);
    expect(splitShellArgs("'keep spaces'")).toEqual(["keep spaces"]);
  });

  it("preserves double-quoted text with POSIX escape handling", () => {
    expect(splitShellArgs('echo "hello world"')).toEqual(["echo", "hello world"]);
    expect(splitShellArgs('"escaped \\"quote\\""')).toEqual(['escaped "quote"']);
  });

  it("handles backslash escapes outside quotes", () => {
    expect(splitShellArgs("path\\ with\\ spaces")).toEqual(["path with spaces"]);
    expect(splitShellArgs("a\\ b c")).toEqual(["a b", "c"]);
  });

  it("stops at a word-start comment character", () => {
    expect(splitShellArgs("run # this is a comment")).toEqual(["run"]);
    expect(splitShellArgs("# comment")).toBeNull();
  });

  it("returns null for unterminated single quote", () => {
    expect(splitShellArgs("echo 'unclosed")).toBeNull();
  });

  it("returns null for unterminated double quote", () => {
    expect(splitShellArgs('echo "unclosed')).toBeNull();
  });

  it("returns null for trailing backslash", () => {
    expect(splitShellArgs("trailing \\")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(splitShellArgs("")).toBeNull();
  });

  it("handles mixed quoting and escaping", () => {
    expect(splitShellArgs("cmd 'single arg' \"double arg\" escaped\\ arg")).toEqual([
      "cmd",
      "single arg",
      "double arg",
      "escaped arg",
    ]);
  });
});
