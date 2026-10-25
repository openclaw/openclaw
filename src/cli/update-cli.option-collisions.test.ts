import { Command } from "commander";
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

// mock-isolation: test real CLI parsing without update, repair, or wizard effects.
vi.mock("./update-cli/update-command.js", () => ({ updateCommand: mocks.updateCommand }));
vi.mock("./update-cli/update-command-finalize.js", () => ({
  updateFinalizeCommand: mocks.updateFinalizeCommand,
}));

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
vi.mock("./update-cli/wizard.js", () => ({ updateWizardCommand: mocks.updateWizardCommand }));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

const run = (args: string | string[]) =>
  runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", ...(typeof args === "string" ? args.split(" ") : args)],
  });

function expectOptions(mock: { mock: { calls: unknown[][] } }, options: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options));
}

function expectRejected(message: string, ...commands: Array<typeof mocks.updateCommand>) {
  expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  for (const command of commands) {
    expect(command).not.toHaveBeenCalled();
  }
}

const adoptionArgs =
  "adopt-immutable --root /opt/example --service example.service --account openclaw --state-dir /var/lib/example --config /etc/example/openclaw.json --runtime /usr/bin/node";

describe("update cli option collisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("describes the shared status deadline in rendered timeout help", async () => {
    const program = new Command();
    let output = "";
    program.configureOutput({ writeOut: (text) => (output += text) }).exitOverride();
    registerUpdateCli(program);
    await expect(
      program.parseAsync(["update", "status", "--help"], { from: "user" }),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output.replace(/\s+/g, " ")).toContain(
      "--timeout <seconds> Check timeout (default: shared 30s; longer values extend it)",
    );
  });

  it.each([
    { args: "--full-integrity-check", target: mocks.updateCommand },
    { args: "repair --full-integrity-check", target: mocks.updateFinalizeCommand },
    { args: "--full-integrity-check wizard", target: mocks.updateWizardCommand },
  ])("passes full migration integrity selection through $args", async ({ args, target }) => {
    await run(args);
    expectOptions(target, { fullIntegrityCheck: true });
  });

  it.each([
    [adoptionArgs, expect.stringContaining("--previous-updater-stopped")],
    [["--channel", "", "cleanup"], expect.stringContaining("is not supported")],
    ["--no-restart cleanup", expect.stringContaining("is not supported")],
    ["--accept-capabilities cleanup", expect.stringContaining("is not supported")],
    [
      "--reapply-local-overrides status",
      expect.stringContaining("--reapply-local-overrides is not supported"),
    ],
    [
      "--dry-run repair",
      "--dry-run is not supported for `openclaw update repair`. Run `openclaw update --dry-run` instead.",
    ],
  ] satisfies Array<[string | string[], unknown]>)(
    "rejects %j before invoking an update action",
    async (args, error) => {
      await run(args);
      const { defaultRuntime, ...commands } = mocks;
      expect(defaultRuntime.error).toHaveBeenCalledWith(error);
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      for (const command of Object.values(commands)) {
        expect(command).not.toHaveBeenCalled();
      }
    },
  );

  it("requires explicit activation consent and binds native recovery to its root", async () => {
    await run(
      `${adoptionArgs} --previous-updater-stopped --enable-activation --inspect-release-retention`,
    );
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
    await run("--timeout 600 --json recover --root /opt/example");
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
    await run(`--sha ${sha}`);
    expectOptions(mocks.updateCommand, { sha });
    await run(`--sha ${sha} status`);
    expectRejected("--sha is supported only", mocks.updateStatusCommand);
  });

  it("passes a distinct immutable drain budget and refuses it on unrelated leaves", async () => {
    await run("--drain-timeout 30 --timeout 600");
    expectOptions(mocks.updateCommand, { drainTimeout: "30", timeout: "600" });
    await run("--drain-timeout 30 recover --root /opt/example --timeout 900");
    expectOptions(mocks.updateRecoverImmutableCommand, { drainTimeout: "30", timeout: "900" });
    await run("--drain-timeout 30 status");
    expectRejected("--drain-timeout is supported only", mocks.updateStatusCommand);
  });

  it("supports inherited cleanup options", async () => {
    await run("--dry-run --json --yes cleanup");
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: true,
      json: true,
      yes: true,
    });
    expect(mocks.updateCommand).not.toHaveBeenCalled();
  });

  it("forwards all explicitly inherited options to update finalize", async () => {
    await run("--json --timeout 31 --channel beta --yes finalize");
    expectOptions(mocks.updateFinalizeCommand, {
      channel: "beta",
      json: true,
      timeout: "31",
      yes: true,
    });
  });

  it("preserves an explicitly empty status timeout over its inherited value", async () => {
    await run(["--timeout", "9", "status", "--json", "--timeout", ""]);
    expectOptions(mocks.updateStatusCommand, { json: true, timeout: "" });
  });
});
