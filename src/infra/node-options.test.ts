import { describe, expect, it } from "vitest";
import { parseNodeOptionsEnvVar, stripNodeStartupHooks } from "../../node-runtime-env.mjs";

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

it("strips startup hooks and their arguments while preserving other Node options", () => {
  const options = [
    '--im"port" "file:///instrumentation hook.mjs"',
    "--import=./second.mjs",
    "--loader ./loader.mjs",
    "--loader=./other.mjs",
    "--experimental_loader ./legacy.mjs",
    "--experimental-loader=./other-legacy.mjs",
    "--require ./hook.cjs",
    "--require=./second.cjs",
    "-r ./short.cjs",
    "-r./attached.cjs",
    '--max-old-space-size=256 --conditions "with spaces" --no-warnings',
  ].join(" ");
  expect(parseNodeOptionsEnvVar(stripNodeStartupHooks(options))).toEqual([
    "--max-old-space-size=256",
    "--conditions",
    "with spaces",
    "--no-warnings",
  ]);
  expect(stripNodeStartupHooks(undefined)).toBeUndefined();
  expect(stripNodeStartupHooks("--no-warnings")).toBe("--no-warnings");
  expect(() => stripNodeStartupHooks('"unterminated')).toThrow("Invalid NODE_OPTIONS");
});
