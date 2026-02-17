import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerCompletionCli } from "./completion-cli.js";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .finally(() => {
      process.stdout.write = origWrite;
    })
    .then(() => chunks.join(""));
}

describe("completion cli", () => {
  it("generates bash completion including heavy subcommands", async () => {
    const program = new Command("openclaw");
    registerCompletionCli(program);

    const output = await captureStdout(() =>
      program.parseAsync(["node", "openclaw", "completion", "--shell", "bash"]),
    );

    // Core subcommands should be present
    expect(output).toContain("gateway");
    expect(output).toContain("logs");
    // Heavy subcommands (registered as stubs) should still appear
    expect(output).toContain("plugins");
    expect(output).toContain("pairing");
  });

  it("generates zsh completion including heavy subcommands", async () => {
    const program = new Command("openclaw");
    registerCompletionCli(program);

    const output = await captureStdout(() =>
      program.parseAsync(["node", "openclaw", "completion", "--shell", "zsh"]),
    );

    expect(output).toContain("compdef");
    expect(output).toContain("gateway");
    expect(output).toContain("plugins");
    expect(output).toContain("pairing");
  });

  it("generates fish completion including heavy subcommands", async () => {
    const program = new Command("openclaw");
    registerCompletionCli(program);

    const output = await captureStdout(() =>
      program.parseAsync(["node", "openclaw", "completion", "--shell", "fish"]),
    );

    expect(output).toContain("plugins");
    expect(output).toContain("pairing");
    expect(output).toContain("gateway");
  });
});
