// Parent default help tests cover parent command help fallback behavior.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { applyParentDefaultHelpAction, isParentDefaultHelpAction } from "./parent-default-help.js";

describe("applyParentDefaultHelpAction (#73077)", () => {
  let originalExitCode: NodeJS.Process["exitCode"];
  let originalEnv: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    originalExitCode = process.exitCode;
    originalEnv = captureEnv(["OPENCLAW_SUPPRESS_HELP_BANNER"]);
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = originalExitCode;
    originalEnv.restore();
  });

  function buildParent(): Command {
    const program = new Command();
    program.exitOverride();
    const parent = program.command("parent").description("test parent");
    parent.exitOverride();
    parent.command("list").action(() => {});
    parent.command("status").action(() => {});
    return parent;
  }

  it("invokes parent help and exits 0 when invoked without subcommand", async () => {
    const parent = buildParent();
    const suppressHelpBannerValues: Array<string | undefined> = [];
    const helpSpy = vi.spyOn(parent, "outputHelp").mockImplementation(() => {
      suppressHelpBannerValues.push(process.env.OPENCLAW_SUPPRESS_HELP_BANNER);
    });
    expect(isParentDefaultHelpAction(parent)).toBe(false);
    applyParentDefaultHelpAction(parent);
    expect(isParentDefaultHelpAction(parent)).toBe(true);
    await parent.parent!.parseAsync(["node", "test", "parent"]);
    expect(helpSpy).toHaveBeenCalledTimes(1);
    expect(suppressHelpBannerValues).toEqual(["1"]);
    expect(process.env.OPENCLAW_SUPPRESS_HELP_BANNER).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("still routes through subcommand actions when one is invoked", async () => {
    const parent = buildParent();
    const listAction = vi.fn();
    parent.commands.find((c) => c.name() === "list")!.action(listAction);
    const helpSpy = vi.spyOn(parent, "outputHelp").mockImplementation(() => {});
    applyParentDefaultHelpAction(parent);
    await parent.parent!.parseAsync(["node", "test", "parent", "list"]);
    expect(listAction).toHaveBeenCalledTimes(1);
    expect(helpSpy).not.toHaveBeenCalled();
  });
});
