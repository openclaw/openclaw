// Invalid numeric CLI flags must surface their reason without OPENCLAW_DEBUG.
import { describe, expect, it } from "vitest";
import { formatCliFailureLines } from "./failure-output.js";
import { parseOptionalPositiveInteger } from "./parse-positive-integer.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

function humanFailure(run: () => unknown, argv: string[]): string[] {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return formatCliFailureLines({
    title: "The CLI command failed.",
    error,
    argv: ["node", "openclaw", ...argv],
    env: {},
  });
}

describe("numeric flag failures", () => {
  it.each([
    ["--limit", "abc"],
    ["--limit", "0"],
    ["--max-bytes", "abc"],
    ["--interval", "abc"],
  ])("shows the reason for logs %s %s", (flag, raw) => {
    expect(
      humanFailure(() => parseOptionalPositiveInteger(raw, flag), ["logs", flag, raw]),
    ).toEqual([`${flag} must be a positive integer`]);
  });

  it("shows the reason for tui --history-limit", () => {
    expect(
      humanFailure(
        () => parseOptionalPositiveInteger("abc", "--history-limit", "."),
        ["tui", "--history-limit", "abc"],
      ),
    ).toEqual(["--history-limit must be a positive integer."]);
  });

  it.each([
    [["devices", "list"], "--timeout"],
    [["channels", "status"], "--timeout"],
  ])("shows the reason for %j %s", (command, flag) => {
    expect(
      humanFailure(
        () => parseTimeoutMsWithFallback("abc", 30_000, { flagName: flag }),
        [...command, flag, "abc"],
      ),
    ).toEqual([
      `Invalid ${flag}. Use a positive millisecond value, e.g. ${flag} 30000. Received: "abc".`,
    ]);
  });

  it("shows the reason for an empty timeout when invalidType is error", () => {
    expect(
      humanFailure(
        () => parseTimeoutMsWithFallback("", 30_000, { invalidType: "error" }),
        ["devices", "list", "--timeout", ""],
      ),
    ).toEqual(["Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000."]);
  });
});
