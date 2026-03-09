import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { generateZshCompletion } from "./completion-cli.js";

describe("generateZshCompletion", () => {
  it("initializes compinit only when compdef is unavailable", () => {
    const program = new Command();
    program.name("openclaw");
    program.command("status").description("show status");

    const script = generateZshCompletion(program);

    expect(script).toContain("if ! (( $+functions[compdef] )); then");
    expect(script).toContain("autoload -Uz compinit");
    expect(script).toContain("compinit");
    expect(script).toContain("compdef _openclaw_root_completion -- openclaw");
  });

  it("rejects unsafe command names before emitting zsh code", () => {
    const program = new Command();
    program.name("openclaw; rm -rf /");

    expect(() => generateZshCompletion(program)).toThrow(/unsafe command name/i);
  });

  it("escapes zsh descriptions and emits quoted specs per option flag", () => {
    const program = new Command();
    program
      .name("openclaw")
      .description("root")
      .option("-s, --safe", 'danger $(touch /tmp/pwned) `whoami` [x] "quoted"');
    program.command("status").description("show $(uname) `id` status");

    const script = generateZshCompletion(program);

    expect(script).toContain(
      '"(--safe -s)--safe[danger \\$(touch /tmp/pwned) \\`whoami\\` \\[x\\] \\"quoted\\"]"',
    );
    expect(script).toContain(
      '"(--safe -s)-s[danger \\$(touch /tmp/pwned) \\`whoami\\` \\[x\\] \\"quoted\\"]"',
    );
    expect(script).toContain("'status[show \\$(uname) \\`id\\` status]'");
    expect(script).not.toContain("{--safe,-s}");
  });

  it("rejects unsafe option flags before emitting zsh code", () => {
    const program = new Command();
    program.name("openclaw");
    program.addOption(new Command().createOption("--safe$(id)", "unsafe"));

    expect(() => generateZshCompletion(program)).toThrow(/unsafe option flag/i);
  });
});
