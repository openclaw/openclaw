import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(async (_opts: unknown) => {}),
  adopt: vi.fn(async (_opts: unknown) => {}),
  recover: vi.fn(async (_opts: unknown) => {}),
  update: vi.fn(async (_opts: unknown) => {}),
  finalize: vi.fn(async (_opts: unknown) => {}),
  status: vi.fn(async (_opts: unknown) => {}),
  wizard: vi.fn(async (_opts: unknown) => {}),
  defaultRuntime: { error: vi.fn(), exit: vi.fn() },
}));

// mock-isolation: test real CLI parsing without update, repair, or wizard effects.
vi.mock("./update-cli/update-command.js", () => ({ updateCommand: mocks.update }));
// mock-isolation: CLI parsing must not execute finalization effects.
vi.mock("./update-cli/update-command-finalize.js", () => ({
  updateFinalizeCommand: mocks.finalize,
}));
// mock-isolation: CLI parsing must not execute repair effects.
vi.mock("./update-cli/update-repair-command.js", () => ({ updateRepairCommand: mocks.finalize }));
// mock-isolation: CLI parsing must not remove installed runtime state.
vi.mock("./update-cli/cleanup.js", () => ({ updateCleanupCommand: mocks.cleanup }));
// mock-isolation: CLI parsing must not adopt or recover an installed runtime.
vi.mock("./update-cli/update-command-immutable.js", () => ({
  updateAdoptImmutableCommand: mocks.adopt,
  updateRecoverImmutableCommand: mocks.recover,
}));
// mock-isolation: CLI parsing must not inspect installed runtime state.
vi.mock("./update-cli/status.js", () => ({ updateStatusCommand: mocks.status }));
// mock-isolation: CLI parsing must not enter the interactive update wizard.
vi.mock("./update-cli/wizard.js", () => ({ updateWizardCommand: mocks.wizard }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

const run = (args: string | string[]) =>
  runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", ...(typeof args === "string" ? args.split(" ") : args)],
  });
const adoptionArgs =
  "adopt-immutable --root /opt/example --service example.service --account openclaw --state-dir /var/lib/example --config /etc/example/openclaw.json --runtime /usr/bin/node";
const adoptionOptions = {
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
};
const sha = "a".repeat(40);
type Invocation = { args: string | string[]; expected: unknown };
type ForwardedInvocation = Invocation & { target: typeof mocks.update };
beforeEach(() => vi.clearAllMocks());

it("describes the shared status deadline in rendered timeout help", async () => {
  const program = new Command();
  let output = "";
  program.configureOutput({ writeOut: (text) => (output += text) }).exitOverride();
  registerUpdateCli(program);
  await expect(
    program.parseAsync(["update", "status", "--help"], { from: "user" }),
  ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
  expect(output.replace(/\s+/g, " ")).toContain(
    "--timeout <seconds> Check timeout (default: shared 30s; longer values extend it)",
  );
});

it.each`
  args                                                                                            | target            | expected
  ${"--full-integrity-check"}                                                                     | ${mocks.update}   | ${expect.objectContaining({ fullIntegrityCheck: true })}
  ${"repair --full-integrity-check"}                                                              | ${mocks.finalize} | ${expect.objectContaining({ fullIntegrityCheck: true })}
  ${"--full-integrity-check wizard"}                                                              | ${mocks.wizard}   | ${expect.objectContaining({ fullIntegrityCheck: true })}
  ${`${adoptionArgs} --previous-updater-stopped --enable-activation --inspect-release-retention`} | ${mocks.adopt}    | ${expect.objectContaining(adoptionOptions)}
  ${"--timeout 600 --json recover --root /opt/example"}                                           | ${mocks.recover}  | ${{ root: "/opt/example", timeout: "600", drainTimeout: undefined, json: true }}
  ${`--sha ${sha}`}                                                                               | ${mocks.update}   | ${expect.objectContaining({ sha })}
  ${"--drain-timeout 30 --timeout 600"}                                                           | ${mocks.update}   | ${expect.objectContaining({ drainTimeout: "30", timeout: "600" })}
  ${"--drain-timeout 30 recover --root /opt/example --timeout 900"}                               | ${mocks.recover}  | ${expect.objectContaining({ drainTimeout: "30", timeout: "900" })}
  ${"--dry-run --json --yes cleanup"}                                                             | ${mocks.cleanup}  | ${{ dryRun: true, json: true, yes: true }}
  ${"--json --timeout 31 --channel beta --yes finalize"}                                          | ${mocks.finalize} | ${expect.objectContaining({ channel: "beta", json: true, timeout: "31", yes: true })}
  ${["--timeout", "9", "status", "--json", "--timeout", ""]}                                      | ${mocks.status}   | ${expect.objectContaining({ json: true, timeout: "" })}
`("forwards update options for $args", async ({ args, target, expected }: ForwardedInvocation) => {
  await run(args);
  expect(target).toHaveBeenCalledExactlyOnceWith(expected);
  if (target !== mocks.update) {
    expect(mocks.update).not.toHaveBeenCalled();
  }
});

it.each`
  args                                  | expected
  ${adoptionArgs}                       | ${expect.stringContaining("--previous-updater-stopped")}
  ${["--channel", "", "cleanup"]}       | ${expect.stringContaining("is not supported")}
  ${"--no-restart cleanup"}             | ${expect.stringContaining("is not supported")}
  ${"--accept-capabilities cleanup"}    | ${expect.stringContaining("is not supported")}
  ${"--reapply-local-overrides status"} | ${expect.stringContaining("--reapply-local-overrides is not supported")}
  ${"--dry-run repair"}                 | ${"--dry-run is not supported for `openclaw update repair`. Run `openclaw update --dry-run` instead."}
  ${`--sha ${sha} status`}              | ${expect.stringContaining("--sha is supported only")}
  ${"--drain-timeout 30 status"}        | ${expect.stringContaining("--drain-timeout is supported only")}
`("rejects $args before invoking an update action", async ({ args, expected }: Invocation) => {
  await run(args);
  const { defaultRuntime, ...commands } = mocks;
  expect(defaultRuntime.error).toHaveBeenCalledWith(expected);
  expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  for (const command of Object.values(commands)) {
    expect(command).not.toHaveBeenCalled();
  }
});
