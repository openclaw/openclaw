import { describe, expect, it, vi } from "vitest";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";
import { runWithPrecomputedHelpMocks } from "./precomputed-help.test-helpers.js";

describe("tryOutputPrecomputedCommandHelp", () => {
  it.each([
    { args: ["browser", "--help"], renderer: "outputPrecomputedBrowserHelpText", called: [] },
    {
      args: ["--profile", "work", "gateway", "--help"],
      renderer: "outputPrecomputedSubcommandHelpText",
      called: ["gateway"],
    },
  ])("renders unambiguous help $args", async ({ args, renderer, called }) => {
    const output = vi.fn(() => true);
    await expect(
      runWithPrecomputedHelpMocks(tryOutputPrecomputedCommandHelp, ["node", "openclaw", ...args], {
        [renderer]: output,
        env: {},
      }),
    ).resolves.toBe(true);
    expect(output.mock.calls).toEqual([called]);
  });

  it.each([
    { args: ["tasks", "--help"], renderer: "outputPrecomputedSubcommandHelpText" },
    {
      args: ["--log-level", "warn", "tasks", "--help"],
      renderer: "outputPrecomputedSubcommandHelpText",
    },
    { args: ["browser", "--target", "--help"], renderer: "outputPrecomputedBrowserHelpText" },
    {
      args: ["secrets", "apply", "--from", "--help"],
      renderer: "outputPrecomputedSecretsHelpText",
    },
    { args: ["gateway", "--url", "--help"], renderer: "outputPrecomputedSubcommandHelpText" },
    { args: ["--help", "gateway"], renderer: "outputPrecomputedSubcommandHelpText" },
    { args: ["gateway", "--", "--help"], renderer: "outputPrecomputedSubcommandHelpText" },
    { args: ["gateway", "--help", "--version"], renderer: "outputPrecomputedSubcommandHelpText" },
  ])("defers unsupported or ambiguous help $args", async ({ args, renderer }) => {
    const output = vi.fn(() => true);
    await expect(
      runWithPrecomputedHelpMocks(tryOutputPrecomputedCommandHelp, ["node", "openclaw", ...args], {
        [renderer]: output,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(output).not.toHaveBeenCalled();
  });
});
