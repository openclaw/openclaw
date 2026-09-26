// Update CLI option collision tests cover update command flag registration boundaries.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  updateCleanupCommand: vi.fn(async (_opts: unknown) => {}),
  updateCommand: vi.fn(async (_opts: unknown) => {}),
  updateFinalizeCommand: vi.fn(async (_opts: unknown) => {}),
  updateStatusCommand: vi.fn(async (_opts: unknown) => {}),
  updateWizardCommand: vi.fn(async (_opts: unknown) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const {
  updateCommand,
  updateFinalizeCommand,
  updateStatusCommand,
  updateWizardCommand,
  defaultRuntime,
} = mocks;

vi.mock("./update-cli/update-command.js", () => ({
  updateCommand: (opts: unknown) => mocks.updateCommand(opts),
}));

vi.mock("./update-cli/update-command-finalize.js", () => ({
  updateFinalizeCommand: (opts: unknown) => mocks.updateFinalizeCommand(opts),
}));

vi.mock("./update-cli/update-repair-command.js", () => ({
  updateRepairCommand: (opts: unknown) => mocks.updateFinalizeCommand(opts),
}));

vi.mock("./update-cli/cleanup.js", () => ({ updateCleanupCommand: mocks.updateCleanupCommand }));

vi.mock("./update-cli/status.js", () => ({
  updateStatusCommand: (opts: unknown) => mocks.updateStatusCommand(opts),
}));

vi.mock("./update-cli/wizard.js", () => ({
  updateWizardCommand: (opts: unknown) => mocks.updateWizardCommand(opts),
}));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: mocks.defaultRuntime,
  };
});

function firstCallOptions(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls[0]?.[0];
}

type UpdateFinalizeCommandOptions = {
  channel?: string;
  json?: boolean;
  timeout?: string;
  restart?: boolean;
  yes?: boolean;
};

describe("update cli option collisions", () => {
  it.each([
    ["update", "--dry-run", "--json", "--yes", "cleanup"],
    ["update", "cleanup", "--dry-run", "--json", "--yes"],
  ])("supports cleanup options in either position: %j", async (...argv) => {
    await runRegisteredCli({ register: registerUpdateCli, argv });
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: true,
      json: true,
      yes: true,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });
  it.each([
    ["--channel", "beta"],
    ["--tag=beta"],
    ["--timeout", "5"],
    ["--channel", ""],
    ["--channel="],
    ["--channel", "--"],
    ["--channel", "--no-restart"],
    ["--no-restart"],
    ["--accept-capabilities"],
    ["--reapply-local-overrides"],
  ])("rejects unrelated inherited cleanup option %s", async (...flags) => {
    await runRegisteredCli({ register: registerUpdateCli, argv: ["update", ...flags, "cleanup"] });
    expect(mocks.updateCleanupCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("is not supported"));
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it.each([
    "--channel",
    "--tag",
    "--timeout",
    "--no-restart",
    "--accept-capabilities",
    "--version",
    "--reapply-local-overrides",
  ])("rejects update-only or version option %s after cleanup", async (flag) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerUpdateCli(program);
    await expect(
      program.parseAsync(["update", "cleanup", flag], { from: "user" }),
    ).rejects.toMatchObject({
      code: "commander.unknownOption",
      exitCode: 1,
    });
    expect(mocks.updateCleanupCommand).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it("dispatches explicit replay consent to the update owner", async () => {
    await runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "--reapply-local-overrides"],
    });
    expect(updateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ reapplyLocalOverrides: true }),
    );
  });

  it.each(["status", "wizard", "repair", "finalize"])(
    "rejects replay consent on the %s leaf",
    async (leaf) => {
      await runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "--reapply-local-overrides", leaf],
      });
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("--reapply-local-overrides is not supported"),
      );
      expect(updateCommand).not.toHaveBeenCalled();
      expect(updateFinalizeCommand).not.toHaveBeenCalled();
      expect(updateWizardCommand).not.toHaveBeenCalled();
      expect(updateStatusCommand).not.toHaveBeenCalled();
    },
  );

  it("dispatches cleanup after the parent option delimiter", async () => {
    await runRegisteredCli({ register: registerUpdateCli, argv: ["update", "--", "cleanup"] });
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: false,
      json: false,
      yes: false,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    mocks.updateCleanupCommand.mockClear();
    updateCommand.mockClear();
    updateFinalizeCommand.mockClear();
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
      handler: updateStatusCommand,
      expected: { json: true, timeout: "9" },
    },
    {
      name: "forwards parent-captured options to hidden `update finalize`",
      argv: ["update", "finalize", "--json", "--timeout", "17", "--no-restart"],
      handler: updateFinalizeCommand,
      expected: { json: true, timeout: "17", restart: false },
    },
    {
      name: "forwards parent-captured --json/--timeout to `update repair`",
      argv: ["update", "repair", "--json", "--timeout", "19"],
      handler: updateFinalizeCommand,
      expected: { json: true, timeout: "19", restart: false },
    },
    {
      name: "forwards repair channel and confirmation options",
      argv: ["update", "repair", "--channel", "beta", "--yes"],
      handler: updateFinalizeCommand,
      expected: { channel: "beta", yes: true },
    },
    {
      name: "forwards parent-captured --timeout to `update wizard`",
      argv: ["update", "wizard", "--timeout", "13"],
      handler: updateWizardCommand,
      expected: { timeout: "13" },
    },
  ])("$name", async ({ argv, handler, expected }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(firstCallOptions(handler)).toMatchObject(expected);
  });

  it.each([
    { name: "repair", handler: updateFinalizeCommand },
    { name: "finalize", handler: updateFinalizeCommand },
    { name: "wizard", handler: updateWizardCommand },
    { name: "status", handler: updateStatusCommand },
  ])("rejects parent --dry-run before running update $name", async ({ name, handler }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "--dry-run", name],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      `--dry-run is not supported for \`openclaw update ${name}\`. Run \`openclaw update --dry-run\` instead.`,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("lets the explicit update repair channel override its parent", async () => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "--channel", "beta", "--yes", "repair", "--channel", "dev"],
    });

    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
      channel: "dev",
      yes: true,
    });
  });

  it("preserves an explicitly empty parent channel for update repair validation", async () => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "--channel", "", "repair"],
    });

    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
  });

  it("lets an explicitly empty update repair channel override its parent", async () => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "--channel", "beta", "repair", "--channel", ""],
    });

    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
  });

  it.each(["repair", "finalize"])(
    "forwards all explicitly inherited options to update %s",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--json", "--timeout", "31", "--channel", "beta", "--yes", name],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
        channel: "beta",
        json: true,
        restart: false,
        timeout: "31",
        yes: true,
      } satisfies UpdateFinalizeCommandOptions);
    },
  );

  it.each([
    {
      name: "status",
      argv: ["update", "status", "--timeout", ""],
      handler: updateStatusCommand,
    },
    {
      name: "wizard",
      argv: ["update", "wizard", "--timeout", ""],
      handler: updateWizardCommand,
    },
    {
      name: "repair",
      argv: ["update", "repair", "--timeout", ""],
      handler: updateFinalizeCommand,
    },
    {
      name: "finalize",
      argv: ["update", "finalize", "--timeout", ""],
      handler: updateFinalizeCommand,
    },
    {
      name: "status with a valid inherited parent timeout",
      argv: ["update", "--timeout", "9", "status", "--timeout", ""],
      handler: updateStatusCommand,
    },
  ])("preserves an explicitly empty $name timeout for validation", async ({ argv, handler }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(firstCallOptions(handler)).toMatchObject({ timeout: "" });
  });
});
