import { describe, expect, it } from "vitest";
import { resolveForwardedNodeCompilerArgs } from "./node-compiler-args.js";

describe("explicit Node compiler policy", () => {
  it("leaves default compilation untouched", () => {
    expect(resolveForwardedNodeCompilerArgs([])).toEqual([]);
  });

  it("preserves operator and tooling overrides without injecting defaults", () => {
    expect(
      resolveForwardedNodeCompilerArgs([
        "--inspect",
        "--maglev",
        "--no_concurrent_sparkplug",
        "--no-maglev",
        "--stack-size=8192",
      ]),
    ).toEqual(["--maglev", "--no_concurrent_sparkplug", "--no-maglev"]);
  });
});
