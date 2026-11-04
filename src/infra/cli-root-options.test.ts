import { expect, it } from "vitest";
import {
  resolveGatewayCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "../cli/gateway-run-argv.js";
import {
  getCommandArgsWithRootOptions,
  getCommandPositionalsWithRootOptions,
  isValueToken,
} from "./cli-root-options.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];
const runOptions = (...args: string[]) => resolveGatewayRunPreBootstrapOptions(cliArgs(...args));
const positionals = (
  args: string[],
  options: Parameters<typeof getCommandPositionalsWithRootOptions>[1],
) => getCommandPositionalsWithRootOptions(cliArgs(...args), options);

it("classifies value-like and flag-like tokens", () => {
  expect(
    ["work", "-1", "-1.5", "-0.5", "--", "--dev", "-", "", undefined].map(isValueToken),
  ).toEqual([true, true, true, true, false, false, false, false, false]);
});

it.each(["route", "command-path"] as const)(
  "requires the root command before command options in %s mode",
  (mode) => {
    const options = { commandPath: ["models"], booleanFlags: ["--json"], mode };
    expect(positionals(["--json", "models", "status"], options)).toBeNull();
    for (const args of [
      ["models", "--json", "status"],
      ["--profile", "models", "models", "--json", "status"],
    ]) {
      expect(positionals(args, options)).toEqual(["status"]);
    }
  },
);

it.each([
  ["--", "channels", "add", "--channel", "example"],
  ["channels", "--", "add", "--channel", "example"],
  ["channels", "add", "--", "--channel", "example"],
])("retains the literal boundary in a delegated argument tail: %j", (...args) => {
  expect(
    getCommandArgsWithRootOptions(cliArgs(...args), {
      commandPath: ["channels", "add"],
      mode: "command-path",
    }),
  ).toEqual(["--", "--channel", "example"]);
});

it("keeps literal root invocations out of conservative fast routes", () => {
  expect(positionals(["--", "config", "get"], { commandPath: ["config", "get"] })).toBeNull();
});

it("resolves destructive flags after root options without consuming option values", () => {
  expect(runOptions("--log-level", "debug", "gateway", "run", "--force", "--reset")).toEqual({
    force: true,
    reset: true,
  });
  expect(runOptions("gateway", "--token", "--force")).toEqual({
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
  const options = runOptions(...args);
  expect(options?.force).not.toBe(true);
  expect(options?.reset).not.toBe(true);
});
