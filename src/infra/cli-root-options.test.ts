// Covers root CLI option token parsing.
import { describe, expect, it } from "vitest";
import {
  getCommandArgsWithRootOptions,
  getCommandPositionalsWithRootOptions,
  isValueToken,
} from "./cli-root-options.js";

function expectValueTokenCases(
  cases: ReadonlyArray<{ value: string | undefined; expected: boolean }>,
): void {
  for (const { value, expected } of cases) {
    expect(isValueToken(value)).toBe(expected);
  }
}

describe("isValueToken", () => {
  it("classifies value-like and flag-like tokens", () => {
    expectValueTokenCases([
      { value: "work", expected: true },
      { value: "-1", expected: true },
      { value: "-1.5", expected: true },
      { value: "-0.5", expected: true },
      { value: "--", expected: false },
      { value: "--dev", expected: false },
      { value: "-", expected: false },
      { value: "", expected: false },
      { value: undefined, expected: false },
    ]);
  });
});

describe("literal command discovery", () => {
  it.each(["route", "command-path"] as const)(
    "requires the root command before command options in %s mode",
    (mode) => {
      const options = { commandPath: ["models"], booleanFlags: ["--json"], mode };
      expect(
        getCommandPositionalsWithRootOptions(
          ["node", "openclaw", "--json", "models", "status"],
          options,
        ),
      ).toBeNull();
      for (const args of [
        ["models", "--json", "status"],
        ["--profile", "models", "models", "--json", "status"],
      ]) {
        expect(
          getCommandPositionalsWithRootOptions(["node", "openclaw", ...args], options),
        ).toEqual(["status"]);
      }
    },
  );

  it.each([
    ["--", "channels", "add", "--channel", "example"],
    ["channels", "--", "add", "--channel", "example"],
    ["channels", "add", "--", "--channel", "example"],
  ])("retains the literal boundary in a delegated argument tail: %j", (...args) => {
    expect(
      getCommandArgsWithRootOptions(["node", "openclaw", ...args], {
        commandPath: ["channels", "add"],
        mode: "command-path",
      }),
    ).toEqual(["--", "--channel", "example"]);
  });

  it("keeps literal root invocations out of conservative fast routes", () => {
    expect(
      getCommandPositionalsWithRootOptions(["node", "openclaw", "--", "config", "get"], {
        commandPath: ["config", "get"],
      }),
    ).toBeNull();
  });
});
