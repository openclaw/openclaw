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
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

// mock-isolation: CLI parsing must not execute update effects.
vi.mock("./update-cli/update-command.js", () => ({ updateCommand: mocks.updateCommand }));
// mock-isolation: CLI parsing must not execute finalization effects.
vi.mock("./update-cli/update-command-finalize.js", () => ({
  updateFinalizeCommand: mocks.updateFinalizeCommand,
}));

// mock-isolation: CLI parsing must not execute repair effects.
vi.mock("./update-cli/update-repair-command.js", () => ({
  updateRepairCommand: mocks.updateFinalizeCommand,
}));

vi.mock("./update-cli/cleanup.js", () => ({ updateCleanupCommand: mocks.updateCleanupCommand }));
vi.mock("./update-cli/update-command-immutable.js", () => ({
  updateAdoptImmutableCommand: mocks.updateAdoptImmutableCommand,
  updateRecoverImmutableCommand: mocks.updateRecoverImmutableCommand,
}));

// mock-isolation: CLI parsing must not inspect installed runtime state.
vi.mock("./update-cli/status.js", () => ({ updateStatusCommand: mocks.updateStatusCommand }));
// mock-isolation: CLI parsing must not enter the interactive update wizard.
vi.mock("./update-cli/wizard.js", () => ({ updateWizardCommand: mocks.updateWizardCommand }));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

const run = (argv: string[]) => runRegisteredCli({ register: registerUpdateCli, argv });

function expectOptions(mock: { mock: { calls: unknown[][] } }, options: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options));
}

function expectRejected(message: string, ...commands: Array<typeof mocks.updateCommand>) {
  expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  for (const command of commands) {
    expect(command).not.toHaveBeenCalled();
  }
}

describe("update cli option collisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { args: ["--full-integrity-check"], target: mocks.updateCommand },
    { args: ["repair", "--full-integrity-check"], target: mocks.updateFinalizeCommand },
    { args: ["--full-integrity-check", "wizard"], target: mocks.updateWizardCommand },
  ])("passes full migration integrity selection through $args", async ({ args, target }) => {
    await run(["update", ...args]);
    expectOptions(target, { fullIntegrityCheck: true });
  });

  const adoptionArgs = [
    "update adopt-immutable",
    "--root /opt/example --service example.service --account openclaw",
    "--state-dir /var/lib/example --config /etc/example/openclaw.json",
    "--runtime /usr/bin/node",
  ].flatMap((args) => args.split(" "));
  it("requires explicit prior-updater acknowledgement for immutable adoption", async () => {
    await run(adoptionArgs);
    expectRejected("--previous-updater-stopped", mocks.updateAdoptImmutableCommand);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("requires explicit activation consent and binds native recovery to its root", async () => {
    await run([
      ...adoptionArgs,
      "--previous-updater-stopped",
      "--enable-activation",
      "--inspect-release-retention",
    ]);
    expectOptions(mocks.updateAdoptImmutableCommand, {
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
      inspectReleaseRetention: true,
    });
    await run(["update", "--timeout", "600", "--json", "recover", "--root", "/opt/example"]);
    expect(mocks.updateRecoverImmutableCommand).toHaveBeenCalledWith({
      root: "/opt/example",
      timeout: "600",
      drainTimeout: undefined,
      json: true,
    });
    expect(mocks.updateCommand).not.toHaveBeenCalled();
  });

  it("passes exact immutable SHA selection only to the update action", async () => {
    const sha = "a".repeat(40);
    await run(["update", "--sha", sha]);
    expectOptions(mocks.updateCommand, { sha });
    await run(["update", "--sha", sha, "status"]);
    expectRejected("--sha is supported only", mocks.updateStatusCommand);
  });

  it("passes a distinct immutable drain budget and refuses it on unrelated leaves", async () => {
    await run(["update", "--drain-timeout", "30", "--timeout", "600"]);
    expectOptions(mocks.updateCommand, { drainTimeout: "30", timeout: "600" });
    await run("update --drain-timeout 30 recover --root /opt/example --timeout 900".split(" "));
    expectOptions(mocks.updateRecoverImmutableCommand, { drainTimeout: "30", timeout: "900" });
    await run(["update", "--drain-timeout", "30", "status"]);
    expectRejected("--drain-timeout is supported only", mocks.updateStatusCommand);
  });

  it("supports inherited cleanup options", async () => {
    await run(["update", "--dry-run", "--json", "--yes", "cleanup"]);
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: true,
      json: true,
      yes: true,
    });
    expect(mocks.updateCommand).not.toHaveBeenCalled();
  });

  it.each([["--channel", ""], ["--no-restart"], ["--accept-capabilities"]])(
    "rejects unrelated inherited cleanup option %s",
    async (...flags) => {
      await run(["update", ...flags, "cleanup"]);
      expectRejected("is not supported", mocks.updateCleanupCommand, mocks.updateCommand);
      expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("rejects replay consent on update leaves", async () => {
    await run(["update", "--reapply-local-overrides", "status"]);
    expectRejected(
      "--reapply-local-overrides is not supported",
      mocks.updateCommand,
      mocks.updateFinalizeCommand,
      mocks.updateWizardCommand,
      mocks.updateStatusCommand,
    );
  });

  it("rejects parent --dry-run before running update repair", async () => {
    await run(["update", "--dry-run", "repair"]);
    expect(mocks.updateFinalizeCommand).not.toHaveBeenCalled();
    expect(mocks.updateCommand).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "--dry-run is not supported for `openclaw update repair`. Run `openclaw update --dry-run` instead.",
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards all explicitly inherited options to update finalize", async () => {
    await run("update --json --timeout 31 --channel beta --yes finalize".split(" "));
    expectOptions(mocks.updateFinalizeCommand, {
      channel: "beta",
      json: true,
      timeout: "31",
      yes: true,
    });
  });

  it("preserves an explicitly empty status timeout over its inherited value", async () => {
    await run(["update", "--timeout", "9", "status", "--json", "--timeout", ""]);
    expectOptions(mocks.updateStatusCommand, { json: true, timeout: "" });
  });
});
