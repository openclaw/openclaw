import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../commands/sandbox.js", () => {
  throw new Error("Sandbox management runtime is unavailable");
});

vi.mock("../commands/sandbox-explain.js", () => {
  throw new Error("Sandbox explanation runtime is unavailable");
});

describe("sandbox command registration", () => {
  it("renders command help without loading sandbox runtimes", async () => {
    const { registerSandboxCli } = await import("./sandbox-cli.js");
    for (const commandPath of [
      ["sandbox"],
      ["sandbox", "list"],
      ["sandbox", "recreate"],
      ["sandbox", "explain"],
    ]) {
      const output: string[] = [];
      const program = new Command().exitOverride();
      program.configureOutput({ writeOut: (text) => output.push(text) });
      registerSandboxCli(program);

      await expect(
        program.parseAsync([...commandPath, "--help"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
      expect(output.join("")).toContain(commandPath.join(" "));
    }
  });
});
