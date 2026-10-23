// Covers root CLI option token parsing.
import { describe, expect, it } from "vitest";
import {
  resolveGatewayCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "../cli/gateway-run-argv.js";
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

describe("Gateway argv boundaries", () => {
  const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];

  it("resolves destructive flags after root options without consuming option values", () => {
    expect(
      resolveGatewayRunPreBootstrapOptions(
        cliArgs("--log-level", "debug", "gateway", "run", "--force", "--reset"),
      ),
    ).toEqual({ force: true, reset: true });
    expect(resolveGatewayRunPreBootstrapOptions(cliArgs("gateway", "--token", "--force"))).toEqual({
      force: false,
      reset: false,
    });
  });

  it.each([
    { args: ["--", "gateway", "--force"], commandPath: ["gateway", "--force"] },
    { args: ["gateway", "--", "run", "--force"], commandPath: ["gateway", "run"] },
    { args: ["gateway", "run", "--", "--reset"], commandPath: ["gateway", "run"] },
  ])("preserves literal commands without destructive flags: $args", ({ args, commandPath }) => {
    const argv = cliArgs(...args);
    expect(resolveGatewayCommandPath(argv)).toEqual(commandPath);
    const options = resolveGatewayRunPreBootstrapOptions(argv);
    expect(options?.force).not.toBe(true);
    expect(options?.reset).not.toBe(true);
  });
});
