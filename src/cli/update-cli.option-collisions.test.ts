// Update CLI option collision tests cover update command flag registration boundaries.
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

function run(argv: string[]) {
  return runRegisteredCli({ register: registerUpdateCli, argv });
}

function firstCallOptions(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls[0]?.[0];
}

describe("update cli option collisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["update", "--dry-run", "--json", "--yes", "cleanup"],
    ["update", "cleanup", "--dry-run", "--json", "--yes"],
  ])("supports cleanup options in either position: %j", async (...argv) => {
    await run(argv);
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: true,
      json: true,
      yes: true,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it.each([["--channel", ""], ["--no-restart"], ["--accept-capabilities"]])(
    "rejects unrelated inherited cleanup option %s",
    async (...flags) => {
      await run(["update", ...flags, "cleanup"]);
      expect(mocks.updateCleanupCommand).not.toHaveBeenCalled();
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("is not supported"),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(updateCommand).not.toHaveBeenCalled();
    },
  );

  it("dispatches explicit replay consent to the update owner", async () => {
    await run(["update", "--reapply-local-overrides"]);
    expect(updateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ reapplyLocalOverrides: true }),
    );
  });

  it("rejects replay consent on update leaves", async () => {
    await run(["update", "--reapply-local-overrides", "status"]);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--reapply-local-overrides is not supported"),
    );
    expect(updateCommand).not.toHaveBeenCalled();
    expect(updateFinalizeCommand).not.toHaveBeenCalled();
    expect(updateWizardCommand).not.toHaveBeenCalled();
    expect(updateStatusCommand).not.toHaveBeenCalled();
  });

  it("dispatches cleanup after the parent option delimiter", async () => {
    await run(["update", "--", "cleanup"]);
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: false,
      json: false,
      yes: false,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it("forwards the wizard timeout", async () => {
    await run(["update", "wizard", "--timeout", "13"]);
    expect(updateWizardCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateWizardCommand)).toMatchObject({ timeout: "13" });
  });

  it("rejects parent --dry-run before running update repair", async () => {
    await run(["update", "--dry-run", "repair"]);
    expect(updateFinalizeCommand).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "--dry-run is not supported for `openclaw update repair`. Run `openclaw update --dry-run` instead.",
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves an explicitly empty parent channel for update repair validation", async () => {
    await run(["update", "--channel", "", "repair"]);
    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
  });

  it("lets an explicitly empty update repair channel override its parent", async () => {
    await run(["update", "--channel", "beta", "repair", "--channel", ""]);
    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
  });

  it.each(["repair", "finalize"])(
    "forwards all explicitly inherited options to update %s",
    async (name) => {
      await run(["update", "--json", "--timeout", "31", "--channel", "beta", "--yes", name]);
      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
        channel: "beta",
        json: true,
        timeout: "31",
        yes: true,
      });
    },
  );

  it("preserves an explicitly empty status timeout over its inherited value", async () => {
    await run(["update", "--timeout", "9", "status", "--json", "--timeout", ""]);
    expect(updateStatusCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateStatusCommand)).toMatchObject({ json: true, timeout: "" });
  });
});
