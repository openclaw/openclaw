import { describe, expect, it, vi } from "vitest";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";
import { runWithPrecomputedHelpMocks } from "./precomputed-help.test-helpers.js";

describe("tryOutputPrecomputedCommandHelp", () => {
  it.each([
    { args: ["browser", "--help"], commandName: "browser" },
    {
      args: ["--profile", "work", "gateway", "--help"],
      commandName: "gateway",
    },
  ])("renders unambiguous help $args", async ({ args, commandName }) => {
    const output = vi.fn(() => true);
    await expect(
      runWithPrecomputedHelpMocks(tryOutputPrecomputedCommandHelp, ["node", "openclaw", ...args], {
        outputPrecomputedCommandHelpText: output,
        env: {},
      }),
    ).resolves.toBe(true);
    expect(output.mock.calls).toEqual([[commandName]]);
  });

  it.each([
    { args: ["tasks", "--help"] },
    {
      args: ["--log-level", "warn", "tasks", "--help"],
    },
    { args: ["browser", "--target", "--help"] },
    {
      args: ["secrets", "apply", "--from", "--help"],
    },
    { args: ["gateway", "--url", "--help"] },
    { args: ["--help", "gateway"] },
    { args: ["gateway", "--", "--help"] },
    { args: ["gateway", "--help", "--version"] },
  ])("defers unsupported or ambiguous help $args", async ({ args }) => {
    const output = vi.fn(() => true);
    await expect(
      runWithPrecomputedHelpMocks(tryOutputPrecomputedCommandHelp, ["node", "openclaw", ...args], {
        outputPrecomputedCommandHelpText: output,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(output).not.toHaveBeenCalled();
  });
});
