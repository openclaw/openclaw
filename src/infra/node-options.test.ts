import { describe, expect, it } from "vitest";
import { parseNodeOptionsEnvVar } from "./node-options.js";

describe("parseNodeOptionsEnvVar", () => {
  it.each([
    [undefined, []],
    ["", []],
    ['--im"port" "file:///tmp/my hook.mjs"', ["--import", "file:///tmp/my hook.mjs"]],
    ['"--im\\port" "file:///tmp/my hook.mjs"', ["--import", "file:///tmp/my hook.mjs"]],
    ["--experimental_loader ./hook.mjs", ["--experimental_loader", "./hook.mjs"]],
    ["'--import' ./hook.mjs\twith-tab", ["'--import'", "./hook.mjs\twith-tab"]],
    ['--require "" ./hook.cjs', ["--require", "./hook.cjs"]],
  ])("matches Node tokenization for %s", (input, expected) => {
    expect(parseNodeOptionsEnvVar(input)).toEqual(expected);
  });

  it.each(['"--import ./hook.mjs', '"--import ./hook.mjs\\'])(
    "rejects malformed input %j",
    (input) => {
      expect(parseNodeOptionsEnvVar(input)).toBeNull();
    },
  );
});
