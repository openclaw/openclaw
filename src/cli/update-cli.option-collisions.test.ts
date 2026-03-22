import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const updateCommand = vi.fn(async (_opts: unknown) => {});
const updateStatusCommand = vi.fn(async (_opts: unknown) => {});
const updateWizardCommand = vi.fn(async (_opts: unknown) => {});

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn((value: string) => {
    defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
  }),
  writeJson: vi.fn((value: unknown, space = 2) => {
    defaultRuntime.log(JSON.stringify(value, null, space));
  }),
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
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it.each([
    {
      name: "forwards parent-captured --json/--timeout to `update status`",
      argv: ["update", "status", "--json", "--timeout", "9"],
      assert: () => {
        expect(updateStatusCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            json: true,
            timeout: "9",
          }),
        );
      },
    },
    {
      name: "forwards parent-captured --timeout to `update wizard`",
      argv: ["update", "wizard", "--timeout", "13"],
      assert: () => {
        expect(updateWizardCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            timeout: "13",
          }),
        );
      },
    },
  ])("$name", async ({ argv, assert }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv,
    });

    assert();
  });
});
