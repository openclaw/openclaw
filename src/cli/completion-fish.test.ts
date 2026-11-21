import { spawnSync } from "node:child_process";
import { Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";

function captureChoices(choices: string[]) {
  const program = new Command().name("openclaw");
  program.addOption(new Option("--value <value>", "Value").choices(choices));
  const line = getCompletionScript("fish", program)
    .split("\n")
    .find((entry) => entry.startsWith("complete -c openclaw "));
  const capture = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `complete() { while (( $# )); do if [[ "$1" == "-a" ]]; then printf '%s' "$2"; return; fi; shift; done; }\n${line}`,
    ],
    { encoding: "utf8" },
  );
  expect(capture).toMatchObject({ status: 0, stderr: "" });
  return capture.stdout;
}

describe("Fish completion scripts", () => {
  it("quotes apostrophes in subcommand descriptions", () => {
    const program = new Command().name("openclaw");
    program.command("plugins").description("Manage Bob's plugins");
    expect(getCompletionScript("fish", program)).toContain(
      `complete -c openclaw -n "__openclaw_command_path_matches" -a "plugins" -d 'Manage Bob'\\''s plugins'\n`,
    );
  });

  it
    .skipIf(spawnSync("fish", ["--version"], { timeout: 15_000 }).status !== 0)
    .each(["Slash before \\'quote'"])(
    "preserves command, option, and optional-choice descriptions in Fish: %s",
    (description) => {
      const program = new Command().name("openclaw");
      program.command("proof-command").description(description);
      program.addOption(new Option("--proof-option [value]", description).choices(["auto"]));
      const script = getCompletionScript("fish", program);
      const result = spawnSync(
        "fish",
        [
          "--no-config",
          "-c",
          `${script}
complete --do-complete 'openclaw proof-c'
complete --do-complete 'openclaw --proof-o'
complete --do-complete 'openclaw --proof-option a'
`,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(result).toMatchObject({ error: undefined, stderr: "", status: 0 });
      expect(result.stdout.split(/\r?\n/)).toEqual(
        expect.arrayContaining([
          `proof-command\t${description}`,
          `--proof-option\t${description}`,
          `--proof-option=\t${description}`,
          `auto\t${description}`,
        ]),
      );
    },
  );

  it("preserves optional Commander option values without requiring an argument", () => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--color [value]", "Color output").choices(["always", "never"]));
    const line = getCompletionScript("fish", program);

    expect(line).toContain(` -l color -f -a "'always' 'never'" `);
    expect(line).not.toContain(" -r ");
    expect(line).toContain(
      `complete -c openclaw -n "__openclaw_command_path_matches; and contains -- (commandline -opc)[-1] --color" -f -a "'always' 'never'" -d 'Color output'`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves apostrophes and backslashes through both Fish quoting layers",
    () => {
      expect(captureChoices(["Bob's green", "path\\name", "ends\\"])).toBe(
        "'Bob\\'s green' 'path\\\\name' 'ends\\\\'",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps command-shaped Commander choices inert during completion expression parsing",
    () => {
      const marker = "OPENCLAW_FISH_CHOICE_MUST_NOT_EXECUTE";
      const choices = ["(stable)", `$(printf ${marker} >&2)`, "light blue"];
      const captured = captureChoices(choices);
      const evaluation = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", `set -- ${captured}; printf '%s\\n' "$@"`],
        { encoding: "utf8" },
      );
      expect(evaluation).toMatchObject({ status: 0, stderr: "" });
      expect(evaluation.stdout.split("\n").filter(Boolean)).toEqual(choices);
    },
  );
});
