import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { withCliTty } from "../run-main.bare-root.test-support.js";
import { registerCoreCliCommands } from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { registerSetupCommand } from "./register.setup.js";

const { setup, wizard, systemAgent, config, onboardingState, runtime } = vi.hoisted(() => ({
  setup: vi.fn(),
  wizard: vi.fn(),
  systemAgent: vi.fn(),
  config: vi.fn(),
  onboardingState: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

// mock-isolation: Setup routing uses fixture-owned config and command receipts without onboarding or inference.
vi.mock("../../commands/setup.js", () => ({ setupCommand: setup }));
// mock-isolation: Setup routing uses fixture-owned config and command receipts without onboarding or inference.
vi.mock("../../commands/onboard.js", () => ({ setupWizardCommand: wizard }));
// mock-isolation: Setup routing uses fixture-owned config and command receipts without onboarding or inference.
vi.mock("../../commands/system-agent-with-inference.js", () => ({
  runSystemAgentWithInference: systemAgent,
}));

// mock-isolation: Setup routing uses fixture-owned config and command receipts without onboarding or inference.
vi.mock("../../config/config.js", () => ({ readConfigFileSnapshot: config }));

// mock-isolation: Setup routing reads synthetic receipts without opening shared state.
vi.mock("../../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfigAsync: onboardingState,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));

async function runCli(args: string | string[]) {
  const program = new Command();
  registerSetupCommand(program);
  await program.parseAsync(["setup", ...(typeof args === "string" ? args.split(" ") : args)], {
    from: "user",
  });
}
const configPath = "/tmp/openclaw.json";
function configSnapshot(sourceConfig = {}, exists = true) {
  config.mockResolvedValue({ exists, valid: true, path: configPath, sourceConfig });
}
function expectWizard(options: Record<string, unknown>) {
  expect(wizard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options), runtime);
  expect(systemAgent).not.toHaveBeenCalled();
}
function expectNoSetup() {
  expect(setup).not.toHaveBeenCalled();
  expect(wizard).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  configSnapshot({}, false);
});

it.each([
  {
    name: "pending inference",
    sourceConfig: { agents: { defaults: { model: "acme/verified" } } },
    pending: true,
    onboarding: true,
  },
  {
    name: "interrupted access selection",
    sourceConfig: {
      $schema: "https://openclaw.ai/config.json",
      meta: { updatedBy: "fixture" },
      wizard: { securityAcknowledgedAt: "2026-08-02T00:00:00.000Z", accessMode: "guarded" },
    },
    onboarding: true,
  },
  {
    name: "remote Gateway",
    sourceConfig: { gateway: { mode: "remote" } },
    pending: true,
    onboarding: false,
  },
])("routes interactive setup for $name", async ({ name, sourceConfig, pending, onboarding }) => {
  configSnapshot(sourceConfig);
  onboardingState.mockResolvedValue(pending ? { status: "pending" } : undefined);
  await withCliTty(true, async () => {
    await runCli([]);
    expect(onboardingState.mock.calls).toEqual(
      name === "pending inference" ? [["/tmp/openclaw.json", sourceConfig]] : [],
    );
    if (onboarding) {
      expectWizard({ json: false });
    } else {
      expect(systemAgent).toHaveBeenCalledExactlyOnceWith(
        { message: undefined, yes: false, json: false },
        runtime,
      );
      expect(wizard).not.toHaveBeenCalled();
    }
  });
});

it("routes JSON setup for an unconfigured system", async () => {
  await runCli("--json");
  expectWizard({ json: true });
});

it("registers the hidden retired-name alias through lazy registration", async () => {
  const program = new Command().name("openclaw");
  registerCoreCliCommands(program, createProgramContext(), ["node", "openclaw", "--help"]);
  expect(program.helpInformation()).not.toContain("crestodian");
  await program.parseAsync(["crestodian", "--message", "status"], { from: "user" });
  expect(systemAgent).toHaveBeenCalledWith({ message: "status", yes: false, json: false }, runtime);
});

it.each([
  ["--baseline --mode remote --json", "--baseline cannot be combined with: --mode.", true],
  [["--gateway-port", ""], "--gateway-port must be an integer between 1 and 65535.", false],
] as const)("rejects invalid setup options: %s", async (args, message, json) => {
  await runCli(typeof args === "string" ? args : [...args]);
  expect(runtime.error).toHaveBeenCalledWith(message);
  if (json) {
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(
        { ok: false, error: { type: "cli_error", message }, phase: "options", message },
        null,
        2,
      ),
    );
  }
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expectNoSetup();
});

it("dispatches scripted onboarding controls", async () => {
  await runCli(
    "--non-interactive --accept-risk --team --gateway-port 18789 --install-daemon --skip-daemon --json --custom-text-input",
  );
  expectWizard({
    nonInteractive: true,
    acceptRisk: true,
    team: true,
    gatewayPort: 18789,
    installDaemon: false,
    json: true,
    customImageInput: false,
  });
  expect(setup).not.toHaveBeenCalled();
});
