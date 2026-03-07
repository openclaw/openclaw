import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { generateZshCompletion } from "./completion-cli.js";

describe("generateZshCompletion", () => {
  it("bootstraps compinit when compdef is unavailable", () => {
    const program = new Command();
    program.name("openclaw");
    program.command("status").description("Show status");

    const script = generateZshCompletion(program);

    expect(script).toContain("if ! command -v compdef >/dev/null 2>&1; then");
    expect(script).toContain("autoload -Uz compinit");
    expect(script).toContain("compinit");
    expect(script).toContain("compdef _openclaw_root_completion openclaw");
  });
});
