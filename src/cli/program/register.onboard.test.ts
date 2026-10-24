import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCliTty } from "../run-main.bare-root.test-support.js";
import { registerCoreCliCommands } from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { expectNoCalls } from "./program.test-helpers.js";
import { registerOnboardCommand } from "./register.onboard.js";
import { registerSetupCommand } from "./register.setup.js";

const {
  acknowledge,
  recommendations,
  refresh,
  systemAgent,
  wizard,
  setup,
  config,
  onboardingState,
  runtime,
} = vi.hoisted(() => ({
  setup: vi.fn(),
  config: vi.fn(),
  onboardingState: vi.fn(),
  acknowledge: vi.fn(),
  recommendations: vi.fn(),
  refresh: vi.fn(),
  systemAgent: vi.fn(),
  wizard: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli: () => "token|oauth|openai-api-key",
}));

// mock-isolation: CLI parsing uses fixed manifest flags, independent of installed plugins.
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveProviderOnboardAuthFlags: () =>
    [
      ["--openai-api-key <key>", "openaiApiKey"],
      ["--openai-api-key <key>", "anotherProviderApiKey"],
      ["--local-embedding-only", "localEmbeddingOnly"],
    ].map(([cliOption, optionKey]) => ({ cliOption, optionKey, description: "Fixture flag" })),
}));

// mock-isolation: Setup routes use synthetic config and never run setup or read shared state.
vi.mock("../../commands/setup.js", () => ({ setupCommand: setup }));
// mock-isolation: Route parsing reads a synthetic config without opening shared state.
vi.mock("../../config/config.js", () => ({ readConfigFileSnapshot: config }));
// mock-isolation: Onboarding status comes from the route fixture, not the local database.
vi.mock("../../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfigAsync: onboardingState,
}));
// mock-isolation: Capture wizard dispatch without executing onboarding side effects.
vi.mock("../../commands/onboard.js", () => ({ setupWizardCommand: wizard }));

// mock-isolation: Capture dispatch without onboarding, inference, or recommendation state.
vi.mock("../../commands/onboard-recommendations.js", () => ({
  acknowledgeOnboardRecommendationsCommand: acknowledge,
  onboardRecommendationsCommand: recommendations,
  refreshOnboardRecommendationsCommand: refresh,
}));

// mock-isolation: CLI parsing captures command dispatch without running onboarding, inference, or recommendation state.
vi.mock("../../commands/system-agent-with-inference.js", () => ({
  runSystemAgentWithInference: systemAgent,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));

function createProgram() {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerOnboardCommand(program);
  return program;
}
async function runCli(args: string[] | string, route: "onboard" | "setup" = "onboard") {
  const argv = typeof args === "string" ? args.split(" ") : args;
  const program = route === "onboard" ? createProgram() : new Command();
  if (route === "setup") {
    registerSetupCommand(program);
  }
  await program.parseAsync([route, ...argv], { from: "user" });
}
function optionFailure(message: unknown) {
  return { ok: false, error: { type: "cli_error", message }, phase: "options", message };
}
function optionsError(message: string) {
  return JSON.stringify(optionFailure(message), null, 2);
}
function expectCall(target: typeof wizard, ...args: unknown[]) {
  expect(target.mock.calls).toEqual([args]);
}

beforeEach(() => vi.resetAllMocks());

it("passes a plugin's boolean consent flag without string coercion", async () => {
  await runCli(["--non-interactive", "--accept-risk", "--local-embedding-only"]);
  expect(wizard.mock.calls).toContainEqual([
    expect.objectContaining({ localEmbeddingOnly: true }),
    runtime,
  ]);
});
it.each([
  ["recommendations --agent writer --json", recommendations, { agent: "writer", json: true }],
  ["recommendations acknowledge", acknowledge, { retry: undefined }],
] as const)("routes %s", async (args, target, options) => {
  await runCli(args);
  expectCall(target, options, runtime);
  expect(wizard).not.toHaveBeenCalled();
});

it("preserves an explicitly blank leaf agent over its parent", async () => {
  await runCli(["recommendations", "--agent", "writer", "refresh", "--agent", ""]);
  expectCall(refresh, { agent: "" }, runtime);
});

it("inherits the parent agent instead of a leaf default", async () => {
  const program = createProgram();
  const recommendationGroup = program.commands
    .find((command) => command.name() === "onboard")
    ?.commands.find((command) => command.name() === "recommendations");
  const leaf = recommendationGroup?.commands.find((command) => command.name() === "refresh");
  expect(leaf).toBeDefined();
  leaf?.setOptionValueWithSource("agent", "analyst", "default");
  await program.parseAsync("onboard recommendations --agent writer refresh".split(" "), {
    from: "user",
  });
  expectCall(refresh, { agent: "writer" }, runtime);
});

it("resolves explicitly disabled daemon installation", async () => {
  await runCli("--no-install-daemon");
  expectCall(wizard, expect.objectContaining({ installDaemon: false }), runtime);
  expect(wizard.mock.calls[0]?.[0]).not.toHaveProperty("tailscaleResetOnExit");
});

it.each([
  [
    "recommendations --json refresh",
    "This recommendations command does not support parent option(s): --json.",
    false,
  ],
  [
    "--json --reset recommendations",
    "This recommendations command does not support parent option(s): --reset.",
    true,
  ],
  [
    "--custom-image-input --custom-text-input --json",
    "Use either --custom-image-input or --custom-text-input, not both.",
    true,
  ],
  [
    "--json --modern --non-interactive",
    "Non-interactive setup requires explicit risk acknowledgement.",
    true,
  ],
  ["--modern --no-install-daemon", "--modern cannot be combined with: --no-install-daemon.", false],
] as const)("rejects invalid options: %s", async (args, message, json) => {
  const partial = args.includes("--modern");
  await runCli(args);
  const expected = partial ? expect.stringContaining(message) : message;
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(expected);
  expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  const logs = runtime.log.mock.calls;
  expect(partial ? logs.map(([value]) => JSON.parse(String(value))) : logs).toEqual(
    json ? (partial ? [optionFailure(expected)] : [[optionsError(message)]]) : [],
  );
  expectNoCalls(recommendations, acknowledge, refresh, wizard, systemAgent);
});

it.each([
  ["--modern --json", { json: true, interactive: true }, {}],
  [
    "--modern --non-interactive --accept-risk",
    { json: false, interactive: false },
    { acceptRisk: true },
  ],
  [
    "--modern --workspace /tmp/work --accept-risk",
    { json: false, interactive: true, setupWorkspace: "/tmp/work" },
    { workspace: "/tmp/work", acceptRisk: true },
  ],
] as const)("routes inference-gated onboarding for %s", async (args, options, fallback) => {
  await runCli(args);
  expectCall(
    systemAgent,
    { yes: false, welcomeVariant: "onboarding", ...options },
    runtime,
    fallback,
  );
  expect(wizard).not.toHaveBeenCalled();
});

describe("setup routing", () => {
  const runSetup = (args: string | string[]) => runCli(args, "setup");
  const configPath = "/tmp/openclaw.json";
  function configSnapshot(sourceConfig = {}, exists = true) {
    config.mockResolvedValue({ exists, valid: true, path: configPath, sourceConfig });
  }
  function expectWizard(options: Record<string, unknown>) {
    expect(wizard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options), runtime);
    expect(systemAgent).not.toHaveBeenCalled();
  }
  beforeEach(() => configSnapshot({}, false));

  it.each([
    ["pending inference", { agents: { defaults: { model: "acme/verified" } } }, true, true],
    [
      "interrupted access selection",
      {
        $schema: "https://openclaw.ai/config.json",
        meta: { updatedBy: "fixture" },
        wizard: { securityAcknowledgedAt: "2026-08-02T00:00:00.000Z", accessMode: "guarded" },
      },
      false,
      true,
    ],
    ["remote Gateway", { gateway: { mode: "remote" } }, true, false],
  ] as const)(
    "routes interactive setup for %s",
    async (name, sourceConfig, pending, onboarding) => {
      configSnapshot(sourceConfig);
      onboardingState.mockResolvedValue(pending ? { status: "pending" } : undefined);
      await withCliTty(true, async () => {
        await runSetup([]);
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
    },
  );

  it("routes JSON setup for an unconfigured system", async () => {
    await runSetup("--json");
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

  it.each([
    ["--baseline --mode remote --json", "--baseline cannot be combined with: --mode.", true],
    [["--gateway-port", ""], "--gateway-port must be an integer between 1 and 65535.", false],
  ] as const)("rejects invalid setup options: %s", async (args, message, json) => {
    await runSetup(typeof args === "string" ? args : [...args]);
    expect(runtime.error).toHaveBeenCalledWith(message);
    if (json) {
      expect(runtime.log).toHaveBeenCalledWith(optionsError(message));
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expectNoCalls(setup, wizard);
  });

  it("dispatches scripted onboarding controls", async () => {
    await runSetup(
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
});
