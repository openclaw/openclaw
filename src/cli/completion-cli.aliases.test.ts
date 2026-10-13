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

afterAll(async () => {
  await powerShellCompletion.close();
});

// Aliases are typeable commands, so every shell must preserve their nested command paths.
describe("completion-cli command aliases", () => {
  itWithFish.each([
    ["an alias-shaped profile value", "openclaw --profile capability cap", "capability"],
  ])("completes real Fish root aliases after %s", (_name, commandLine, expected) => {
    expect(runGeneratedFishCompletion(createAliasedCompletionProgram(), commandLine)).toContain(
      expected,
    );
  });

  it("completes root and nested aliases in zsh lists and dispatch", () => {
    const script = getCompletionScript("zsh", createAliasedCompletionProgram());

    expect(script).toContain("'capability[Run inference]'");
    expect(script).toContain("(infer|capability) _openclaw_infer ;;");
    expect(script).toContain("'create[Add a job]'");
    expect(script).toContain("(add|create) _openclaw_cron_add ;;");
  });

  it.skipIf(process.platform === "win32")("offers options after a nested alias in bash", () => {
    expect(
      runGeneratedBashCompletion(createAliasedCompletionProgram(), [
        "openclaw",
        "--profile",
        "work",
        "cron",
        "create",
        "--a",
      ]),
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

  itWithFish.each([["an aliased nested command", "openclaw cron create -"]])(
    "keeps real Fish alias completions scoped after %s",
    (_name, commandLine) => {
      expect(runGeneratedFishCompletion(createAliasedCompletionProgram(), commandLine)).toEqual([
        "--at",
      ]);
    },
  );

  itWithPowerShell.each([
    ["a global option", "openclaw --profile work cron create --a"],
    ["the canonical nested command", "openclaw --profile work cron add --a"],
  ])("completes real PowerShell nested aliases after %s", async (_name, commandLine) => {
    expect(
      await powerShellCompletion.complete(createAliasedCompletionProgram(), commandLine),
    ).toEqual(["--at"]);
  });
});
