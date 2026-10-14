import { Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { collectShellCompletionCommandTree } from "./completion-command-tree.js";

describe("shell completion command tree", () => {
  it("retains hidden value consumption and inherited-choice shadowing", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-p, --profile <name>").choices(["parent"]));
    program
      .command("child")
      .addOption(new Option("--profile <name>").choices(["child"]).hideHelp())
      .option("--visible", "Visible option");

    const context = collectShellCompletionCommandTree(program).descendants[0];

    expect(context?.completions).toEqual(["--visible"]);
    expect(context?.valueOptions).toEqual(["-p", "--profile"]);
    expect(context?.valueChoices).toEqual([
      { flags: ["-p"], choices: ["parent"], requiresValue: true },
      { flags: ["--profile"], choices: ["child"], requiresValue: true },
    ]);
  });
});
