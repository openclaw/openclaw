// Precomputed help tests cover the strict argv shape required by help fast paths.
import { describe, expect, it, vi } from "vitest";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";

describe("tryOutputPrecomputedCommandHelp", () => {
  it("renders only an unambiguous command help request", async () => {
    const outputBrowserHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(["node", "openclaw", "browser", "--help"], {
        outputPrecomputedBrowserHelpText: outputBrowserHelp,
        env: {},
      }),
    ).resolves.toBe(true);
    expect(outputBrowserHelp).toHaveBeenCalledOnce();
  });

  it.each([{ args: ["tasks", "--help"] }, { args: ["--log-level", "warn", "tasks", "--help"] }])(
    "does not read cached help for the retired Tasks command: $args",
    async ({ args }) => {
      const outputSubcommandHelp = vi.fn(() => true);

      await expect(
        tryOutputPrecomputedCommandHelp(["node", "openclaw", ...args], {
          outputPrecomputedSubcommandHelpText: outputSubcommandHelp,
          env: {},
        }),
      ).resolves.toBe(false);
      expect(outputSubcommandHelp).not.toHaveBeenCalled();
    },
  );

  it("falls back when a command option may own --help as its value", async () => {
    const outputBrowserHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(["node", "openclaw", "browser", "--target", "--help"], {
        outputPrecomputedBrowserHelpText: outputBrowserHelp,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(outputBrowserHelp).not.toHaveBeenCalled();
  });

  it("leaves secrets apply --from --help for Commander to parse", async () => {
    const outputSecretsHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(
        ["node", "openclaw", "secrets", "apply", "--from", "--help"],
        {
          outputPrecomputedSecretsHelpText: outputSecretsHelp,
          env: {},
        },
      ),
    ).resolves.toBe(false);
    expect(outputSecretsHelp).not.toHaveBeenCalled();
  });

  it("renders catalog command help after root selectors", async () => {
    const output = vi.fn(() => true);
    await expect(
      tryOutputPrecomputedCommandHelp(
        ["node", "openclaw", "--profile", "work", "gateway", "--help"],
        { outputPrecomputedSubcommandHelpText: output, env: {} },
      ),
    ).resolves.toBe(true);
    expect(output).toHaveBeenCalledExactlyOnceWith("gateway");
  });

  it.each([
    [["gateway", "--url", "--help"]],
    [["--help", "gateway"]],
    [["gateway", "--", "--help"]],
    [["gateway", "--help", "--version"]],
  ])("defers ambiguous catalog help %j to Commander", async (args) => {
    const output = vi.fn(() => true);
    await expect(
      tryOutputPrecomputedCommandHelp(["node", "openclaw", ...args], {
        outputPrecomputedSubcommandHelpText: output,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(output).not.toHaveBeenCalled();
  });
});
