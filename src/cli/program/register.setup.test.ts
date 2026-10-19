import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../commands/setup.js", () => ({
  setupCommand: setup,
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: wizard,
}));

vi.mock("../../commands/system-agent-with-inference.js", () => ({
  runSystemAgentWithInference: systemAgent,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: config,
}));

// mock-isolation: Setup routing reads synthetic receipts without opening shared state.
vi.mock("../../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfigAsync: onboardingState,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));

async function runCli(args: string[]) {
  const program = new Command();
  registerSetupCommand(program);
  await program.parseAsync(["setup", ...args], { from: "user" });
}
function configSnapshot(sourceConfig = {}, exists = true) {
  config.mockResolvedValue({
    exists,
    valid: true,
    path: "/tmp/openclaw.json",
    sourceConfig,
  });
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

describe("registered setup routing", () => {
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
    const streams = [process.stdin, process.stdout];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
    for (const stream of streams) {
      Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    }
    try {
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
    } finally {
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) {
          Object.defineProperty(stream, "isTTY", descriptor);
        } else {
          Reflect.deleteProperty(stream, "isTTY");
        }
      });
    }
  });

  it("routes JSON setup for an unconfigured system", async () => {
    await runCli(["--json"]);
    expectWizard({ json: true });
  });

  it("registers the hidden retired-name alias through lazy registration", async () => {
    const program = new Command().name("openclaw");
    registerCoreCliCommands(program, createProgramContext(), ["node", "openclaw", "--help"]);
    expect(program.helpInformation()).not.toContain("crestodian");
    await program.parseAsync(["crestodian", "--message", "status"], { from: "user" });
    expect(systemAgent).toHaveBeenCalledWith(
      { message: "status", yes: false, json: false },
      runtime,
    );
  });

  it("rejects onboarding options in baseline mode", async () => {
    await runCli("--baseline --mode remote --json".split(" "));
    const message = "--baseline cannot be combined with: --mode.";
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(
        { ok: false, error: { type: "cli_error", message }, phase: "options", message },
        null,
        2,
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expectNoSetup();
  });

  it("dispatches scripted onboarding controls", async () => {
    await runCli(
      "--non-interactive --accept-risk --team --gateway-port 18789 --install-daemon --skip-daemon --json --custom-text-input".split(
        " ",
      ),
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

  it("rejects a blank gateway port before onboarding dispatch", async () => {
    await runCli(["--gateway-port", ""]);
    expect(runtime.error).toHaveBeenCalledWith(
      "--gateway-port must be an integer between 1 and 65535.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expectNoSetup();
  });
});
