import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerAuthCli } from "./auth-cli.js";

const mocks = vi.hoisted(() => ({
  modelsAuthListCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/models/auth-list.js", () => ({
  modelsAuthListCommand: mocks.modelsAuthListCommand,
}));

describe("auth cli", () => {
  beforeEach(() => {
    mocks.modelsAuthListCommand.mockClear();
  });

  it("registers auth list", () => {
    const program = new Command();
    registerAuthCli(program);

    const auth = program.commands.find((command) => command.name() === "auth");
    expect(auth).toBeDefined();
    expect(auth?.commands.find((command) => command.name() === "list")).toBeDefined();
  });

  it("passes list flags through to the auth list command", async () => {
    await runRegisteredCli({
      register: registerAuthCli,
      argv: ["auth", "--agent", "poe", "list", "--json"],
    });

    expect(mocks.modelsAuthListCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "poe",
        json: true,
        plain: false,
      }),
      expect.any(Object),
    );
  });
});
