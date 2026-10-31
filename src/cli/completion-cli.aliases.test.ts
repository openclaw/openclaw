import { afterAll, describe, expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";
import {
  createAliasedCompletionProgram,
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion,
  runGeneratedFishCompletion,
} from "./completion-cli.test-support.js";

const powerShellCompletion = new PowerShellCompletionRunner();

afterAll(() => powerShellCompletion.close());

// Aliases are typeable commands, so every shell must preserve their nested command paths.
describe("completion-cli command aliases", () => {
  itWithFish.each([
    ["openclaw --profile capability cap", expect.arrayContaining(["capability"])],
    ["openclaw cron create -", ["--at"]],
  ] as const)("completes real Fish aliases: %s", (line, expected) => {
    expect(runGeneratedFishCompletion(createAliasedCompletionProgram(), line)).toEqual(expected);
  });

  it("includes root and nested aliases in zsh command lists", () => {
    const script = getCompletionScript("zsh", createAliasedCompletionProgram());

    expect(script).toContain("'capability[Run inference]'");
    expect(script).toContain("'create[Add a job]'");
  });

  it.skipIf(process.platform === "win32")("offers options after a nested alias in bash", () => {
    expect(
      runGeneratedBashCompletion(
        createAliasedCompletionProgram(),
        "openclaw --profile work cron create --a".split(" "),
      ),
    ).toEqual(["--at"]);
  });

  it("completes aliases and their subtrees in fish", () => {
    const script = getCompletionScript("fish", createAliasedCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches" -a "capability" -d \'Run inference\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches capability" -a "embed" -d \'Embed text\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches cron" -a "create" -d \'Add a job\'',
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches cron create\" -l at -r -d 'Schedule time'",
    );
  });

  itWithPowerShell.each([
    ["a global option", "openclaw --profile work cron create --a"],
    ["the canonical nested command", "openclaw --profile work cron add --a"],
  ])("completes real PowerShell nested aliases after %s", async (_name, commandLine) => {
    expect(
      await powerShellCompletion.complete(createAliasedCompletionProgram(), commandLine),
    ).toEqual(["--at"]);
  });
});
