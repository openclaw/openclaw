import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const updateCommand = vi.fn(async (_opts: unknown) => {});
const updateStatusCommand = vi.fn(async (_opts: unknown) => {});
const updateWizardCommand = vi.fn(async (_opts: unknown) => {});

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("./update-cli/update-command.js", () => ({
  updateCommand: (opts: unknown) => updateCommand(opts),
}));

vi.mock("./update-cli/status.js", () => ({
  updateStatusCommand: (opts: unknown) => updateStatusCommand(opts),
}));

vi.mock("./update-cli/wizard.js", () => ({
  updateWizardCommand: (opts: unknown) => updateWizardCommand(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

describe("update cli option collisions", () => {
  let registerUpdateCli: typeof import("./update-cli.js").registerUpdateCli;

  beforeAll(async () => {
    ({ registerUpdateCli } = await import("./update-cli.js"));
  });

  beforeEach(() => {
    updateCommand.mockClear();
    updateStatusCommand.mockClear();
    updateWizardCommand.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("forwards parent-captured --json/--timeout to `update status`", async () => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "status", "--json", "--timeout", "9"],
    });

    expect(updateStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        timeout: "9",
      }),
    );
  });

  it("forwards parent-captured --timeout to `update wizard`", async () => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "wizard", "--timeout", "13"],
    });

    expect(updateWizardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: "13",
      }),
    );
  });
});
