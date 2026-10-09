// Update CLI option collision tests cover update command flag registration boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  updateCleanupCommand: vi.fn(async (_opts: unknown) => {}),
  updateAdoptImmutableCommand: vi.fn(async (_opts: unknown) => {}),
  updateRecoverImmutableCommand: vi.fn(async (_opts: unknown) => {}),
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
vi.mock("./update-cli/update-command-immutable.js", () => ({
  updateAdoptImmutableCommand: mocks.updateAdoptImmutableCommand,
  updateRecoverImmutableCommand: mocks.updateRecoverImmutableCommand,
}));

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

  const adoptionArgs = [
    "update",
    "adopt-immutable",
    "--root",
    "/opt/example",
    "--service",
    "example.service",
    "--account",
    "openclaw",
    "--state-dir",
    "/var/lib/example",
    "--config",
    "/etc/example/openclaw.json",
    "--runtime",
    "/usr/bin/node",
  ];
  it("requires explicit prior-updater acknowledgement for immutable adoption", async () => {
    await run(adoptionArgs);
    expect(mocks.updateAdoptImmutableCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--previous-updater-stopped"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("requires explicit activation consent and binds native recovery to its root", async () => {
    await run([...adoptionArgs, "--previous-updater-stopped", "--enable-activation"]);
    expect(mocks.updateAdoptImmutableCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/opt/example",
        service: {
          unit: "example.service",
          scope: "system",
          account: "openclaw",
          stateDir: "/var/lib/example",
          configPath: "/etc/example/openclaw.json",
          profile: null,
        },
        runtime: "/usr/bin/node",
        previousUpdaterStopped: true,
        enableActivation: true,
      }),
    );
    await run(["update", "--timeout", "600", "--json", "recover", "--root", "/opt/example"]);
    expect(mocks.updateRecoverImmutableCommand).toHaveBeenCalledWith({
      root: "/opt/example",
      timeout: "600",
      drainTimeout: undefined,
      json: true,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it("passes exact immutable SHA selection only to the update action", async () => {
    const sha = "a".repeat(40);
    await run(["update", "--sha", sha]);
    expect(updateCommand).toHaveBeenCalledWith(expect.objectContaining({ sha }));
    await run(["update", "--sha", sha, "status"]);
    expect(updateStatusCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--sha is supported only"),
    );
  });

  it("passes a distinct immutable drain budget and refuses it on unrelated leaves", async () => {
    await run(["update", "--drain-timeout", "30", "--timeout", "600"]);
    expect(updateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ drainTimeout: "30", timeout: "600" }),
    );
    await run([
      "update",
      "--drain-timeout",
      "30",
      "recover",
      "--root",
      "/opt/example",
      "--timeout",
      "900",
    ]);
    expect(mocks.updateRecoverImmutableCommand).toHaveBeenCalledWith(
      expect.objectContaining({ drainTimeout: "30", timeout: "900" }),
    );
    await run(["update", "--drain-timeout", "30", "status"]);
    expect(updateStatusCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--drain-timeout is supported only"),
    );
  });

  it.each([["update", "--dry-run", "--json", "--yes", "cleanup"]])(
    "supports cleanup options in either position: %j",
    async (...argv) => {
      await run(argv);
      expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
        dryRun: true,
        json: true,
        yes: true,
      });
      expect(updateCommand).not.toHaveBeenCalled();
    },
  );

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

  it.each(["finalize"])("forwards all explicitly inherited options to update %s", async (name) => {
    await run(["update", "--json", "--timeout", "31", "--channel", "beta", "--yes", name]);
    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
      channel: "beta",
      json: true,
      timeout: "31",
      yes: true,
    });
  });

  it("preserves an explicitly empty status timeout over its inherited value", async () => {
    await run(["update", "--timeout", "9", "status", "--json", "--timeout", ""]);
    expect(updateStatusCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateStatusCommand)).toMatchObject({ json: true, timeout: "" });
  });
});
