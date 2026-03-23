import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";

function createCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.description("CLI root");
  program.option("-v, --verbose", "Verbose output");

  const gateway = program.command("gateway").description("Gateway commands");
  gateway.option("--force", "Force the action");

  gateway.command("status").description("Show gateway status").option("--json", "JSON output");
  gateway.command("restart").description("Restart gateway");

  return program;
}

describe("completion-cli", () => {
  it("generates zsh functions for nested subcommands", () => {
    const script = getCompletionScript("zsh", createCompletionProgram());

    expect(script).toContain("_openclaw_gateway()");
    expect(script).toContain("(status) _openclaw_gateway_status ;;");
    expect(script).toContain("(restart) _openclaw_gateway_restart ;;");
    expect(script).toContain("--force[Force the action]");
  });

  it("zsh completion script includes compinit guard before compdef call (issue #14289)", () => {
    const script = getCompletionScript("zsh", createCompletionProgram());

    // On fresh zsh setups compinit is not called, so compdef is unavailable.
    // The generated script must guard against this by autoloading compinit first.
    expect(script).toContain("compinit");
    expect(script).toContain("type compdef");

    // Guard must appear before the compdef invocation
    const compdefIndex = script.indexOf("compdef _openclaw_root_completion");
    const guardIndex = script.indexOf("compinit");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(compdefIndex);
  });

  it("generates PowerShell command paths without the executable prefix", () => {
    const script = getCompletionScript("powershell", createCompletionProgram());

    expect(script).toContain("if ($commandPath -eq 'gateway') {");
    expect(script).toContain("if ($commandPath -eq 'gateway status') {");
    expect(script).not.toContain("if ($commandPath -eq 'openclaw gateway') {");
    expect(script).toContain("$completions = @('status','restart','--force')");
  });

  it("generates fish completions for root and nested command contexts", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__fish_use_subcommand" -a "gateway" -d \'Gateway commands\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__fish_seen_subcommand_from gateway" -a "status" -d \'Show gateway status\'',
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__fish_seen_subcommand_from gateway\" -l force -d 'Force the action'",
    );
  });
});
