import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { createProgramContext } from "./context.js";

const loaded = vi.hoisted(() => ({ backup: vi.fn(), message: vi.fn() }));

vi.mock("../../commands/backup.js", () => {
  loaded.backup();
  return { backupCreateCommand: vi.fn() };
});
vi.mock("../../commands/message.js", () => {
  loaded.message();
  return { messageCommand: vi.fn() };
});

it("registers backup help without loading archive execution", async () => {
  const { registerBackupCommand } = await import("./register.backup.js");
  const program = new Command();
  registerBackupCommand(program);
  expect(
    program.commands.find((command) => command.name() === "backup")?.commands.length,
  ).toBeGreaterThan(0);
  expect(loaded.backup).not.toHaveBeenCalled();
});

it("registers message help without loading delivery execution", async () => {
  const { registerMessageCommands } = await import("./register.message.js");
  const program = new Command();
  registerMessageCommands(program, createProgramContext());
  expect(
    program.commands.find((command) => command.name() === "message")?.commands.length,
  ).toBeGreaterThan(0);
  expect(loaded.message).not.toHaveBeenCalled();
});
