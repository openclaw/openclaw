import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { generateZshCompletion } from "./completion-cli.js";

describe("generateZshCompletion", () => {
  it("initializes compinit when compdef is unavailable", () => {
    const program = new Command("openclaw");
    program.command("agent").description("Manage agents");

    const script = generateZshCompletion(program);

    expect(script).toContain("if (( ! $+functions[compdef] )); then");
    expect(script).toContain("autoload -Uz compinit");
    expect(script).toContain("compinit");
  });

  it("still registers root completion handler", () => {
    const program = new Command("openclaw");
    program.command("status").description("Show status");

    const script = generateZshCompletion(program);

    expect(script).toContain("_openclaw_root_completion()");
    expect(script).toContain("compdef _openclaw_root_completion openclaw");
  });
});
