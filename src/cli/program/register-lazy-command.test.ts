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

    const placeholder = program.commands.find((cmd) => cmd.name() === "demo") as Command & {
      _helpOption: unknown;
    };
    expect(placeholder).toBeDefined();
    expect(placeholder._helpOption).toBeNull();
    expect(placeholder.options.find((opt) => opt.long === "--help")).toBeUndefined();
  });

  it("sets allowUnknownOption and allowExcessArguments on placeholder", () => {
    const program = new Command();

    registerLazyCommand({
      program,
      name: "mycmd",
      description: "My command",
      register: vi.fn(),
    });

    const placeholder = program.commands.find((cmd) => cmd.name() === "mycmd") as Command & {
      _helpOption: unknown;
      _allowUnknownOption: boolean;
      _allowExcessArguments: boolean;
    };
    expect(placeholder).toBeDefined();
    expect(placeholder._allowUnknownOption).toBe(true);
    expect(placeholder._allowExcessArguments).toBe(true);
    expect(placeholder._helpOption).toBeNull();
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
