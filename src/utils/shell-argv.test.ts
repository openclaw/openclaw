import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shell-argv.js";

describe("splitShellArgs", () => {
  it("splits whitespace and respects quotes", () => {
    expect(splitShellArgs(`qmd --foo "bar baz"`)).toEqual(["qmd", "--foo", "bar baz"]);
    expect(splitShellArgs(`qmd --foo 'bar baz'`)).toEqual(["qmd", "--foo", "bar baz"]);
  });

  it("supports backslash escapes inside double quotes", () => {
    expect(splitShellArgs(String.raw`echo "a\"b"`)).toEqual(["echo", `a"b`]);
    expect(splitShellArgs(String.raw`echo "\$HOME"`)).toEqual(["echo", "$HOME"]);
  });

  it("returns null for unterminated quotes", () => {
    expect(splitShellArgs(`echo "oops`)).toBeNull();
    expect(splitShellArgs(`echo 'oops`)).toBeNull();
  });
});
