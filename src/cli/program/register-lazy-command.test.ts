import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerLazyCommand } from "./register-lazy-command.js";

describe("registerLazyCommand", () => {
  it("disables help on the placeholder so --help passes through to the action handler", () => {
    const program = new Command();

    registerLazyCommand({
      program,
      name: "demo",
      description: "Demo command",
      register: vi.fn(),
    });

    const placeholder = program.commands.find((cmd) => cmd.name() === "demo")!;
    expect(placeholder).toBeDefined();
    expect(placeholder.options.find((opt) => opt.long === "--help")).toBeUndefined();
  });

  it("sets allowUnknownOption and allowExcessArguments on placeholder", async () => {
    const makeRegister = (prog: Command) =>
      vi.fn().mockImplementation(() => {
        prog
          .command("mycmd-sub")
          .description("sub")
          .action(() => {});
      });

    // allowUnknownOption: placeholder should not reject unknown flags before
    // the action handler runs; after reparse the subcommand tree is populated
    // so unknownOption should not fire at the placeholder level.
    {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
      const register = makeRegister(program);

      registerLazyCommand({
        program,
        name: "mycmd",
        description: "My command",
        register,
      });

      try {
        await program.parseAsync(["mycmd", "--some-unknown-flag"], { from: "user" });
      } catch (err: unknown) {
        expect((err as { code?: string }).code).not.toBe("commander.unknownOption");
      }
    }

    // allowExcessArguments: placeholder should not reject extra operands before
    // the action handler runs.
    {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
      const register = makeRegister(program);

      registerLazyCommand({
        program,
        name: "mycmd",
        description: "My command",
        register,
      });

      try {
        await program.parseAsync(["mycmd", "extra-arg"], { from: "user" });
      } catch (err: unknown) {
        expect((err as { code?: string }).code).not.toBe("commander.excessArguments");
      }
    }
  });

  it("removes placeholder and invokes register on action", async () => {
    const program = new Command();
    program.exitOverride();

    const register = vi.fn();

    registerLazyCommand({
      program,
      name: "demo",
      description: "Demo command",
      register,
    });

    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    try {
      await program.parseAsync(["demo"], { from: "user" });
    } catch {
      // reparse may fail because register doesn't add real subcommands;
      // we only care that register was invoked
    }

    expect(register).toHaveBeenCalledTimes(1);
  });
});
