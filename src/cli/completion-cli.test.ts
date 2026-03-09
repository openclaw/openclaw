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
    expect(script).toContain("compdef _openclaw_root_completion openclaw");
  });
});
