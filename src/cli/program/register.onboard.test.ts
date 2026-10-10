import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerOnboardCommand } from "./register.onboard.js";

const mocks = vi.hoisted(() => ({
  acknowledgeOnboardRecommendationsCommand: vi.fn(),
  onboardRecommendationsCommand: vi.fn(),
  refreshOnboardRecommendationsCommand: vi.fn(),
  runSystemAgentWithInference: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupWizardCommandMock = mocks.setupWizardCommandMock;
const runtime = mocks.runtime;

vi.mock("../../commands/auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli: () => "token|oauth|openai-api-key",
}));

vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveProviderOnboardAuthFlags: () => [
    {
      cliOption: "--openai-api-key <key>",
      description: "OpenAI API key",
      optionKey: "openaiApiKey",
    },
    {
      cliOption: "--openai-api-key <key>",
      description: "Another provider's conflicting API key flag",
      optionKey: "anotherProviderApiKey",
    },
  ],
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../commands/onboard-recommendations.js", () => ({
  acknowledgeOnboardRecommendationsCommand: mocks.acknowledgeOnboardRecommendationsCommand,
  onboardRecommendationsCommand: mocks.onboardRecommendationsCommand,
  refreshOnboardRecommendationsCommand: mocks.refreshOnboardRecommendationsCommand,
}));

vi.mock("../../commands/system-agent-with-inference.js", () => ({
  runSystemAgentWithInference: mocks.runSystemAgentWithInference,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

async function runCli(args: string[]) {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerOnboardCommand(program);
  await program.parseAsync(["onboard", ...args], { from: "user" });
}

beforeEach(() => vi.resetAllMocks());

describe("registered onboarding", () => {
  it.each([
    {
      args: "recommendations --agent writer --json",
      target: mocks.onboardRecommendationsCommand,
      options: { agent: "writer", json: true },
    },
    {
      args: "--json recommendations",
      target: mocks.onboardRecommendationsCommand,
      options: { json: true },
    },
    {
      args: "recommendations acknowledge",
      target: mocks.acknowledgeOnboardRecommendationsCommand,
      options: { retry: undefined },
    },
    {
      args: "recommendations acknowledge --retry chat-plugin @demo-owner/notes",
      target: mocks.acknowledgeOnboardRecommendationsCommand,
      options: { retry: ["chat-plugin", "@demo-owner/notes"] },
    },
    {
      args: "recommendations --agent writer acknowledge --agent analyst",
      target: mocks.acknowledgeOnboardRecommendationsCommand,
      options: { agent: "analyst", retry: undefined },
    },
    {
      args: "recommendations refresh",
      target: mocks.refreshOnboardRecommendationsCommand,
      options: {},
    },
  ])("routes $args", async ({ args, target, options }) => {
    await runCli(args.split(" "));
    expect(target).toHaveBeenCalledExactlyOnceWith(options, runtime);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["recommendations", mocks.onboardRecommendationsCommand],
    ["recommendations acknowledge", mocks.acknowledgeOnboardRecommendationsCommand],
    ["recommendations refresh", mocks.refreshOnboardRecommendationsCommand],
  ] as const)("reports asynchronous storage failures for %s", async (args, target) => {
    target.mockRejectedValueOnce(new Error("synthetic recommendation persistence failure"));
    await runCli(args.split(" "));
    expect(runtime.error).toHaveBeenCalledWith("synthetic recommendation persistence failure");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves an explicitly blank leaf agent over its parent", async () => {
    await runCli(["recommendations", "--agent", "writer", "refresh", "--agent", ""]);
    expect(mocks.refreshOnboardRecommendationsCommand).toHaveBeenCalledExactlyOnceWith(
      { agent: "" },
      runtime,
    );
  });

  it("inherits the parent agent instead of a leaf default", async () => {
    const program = new Command().enablePositionalOptions().exitOverride();
    registerOnboardCommand(program);
    const recommendations = program.commands
      .find((command) => command.name() === "onboard")
      ?.commands.find((command) => command.name() === "recommendations");
    const leaf = recommendations?.commands.find((command) => command.name() === "refresh");
    if (!leaf) {
      throw new Error("Expected registered recommendations refresh command");
    }
    leaf.setOptionValueWithSource("agent", "analyst", "default");
    await program.parseAsync("onboard recommendations --agent writer refresh".split(" "), {
      from: "user",
    });
    expect(mocks.refreshOnboardRecommendationsCommand).toHaveBeenCalledExactlyOnceWith(
      { agent: "writer" },
      runtime,
    );
  });

  it.each([
    "--reset recommendations",
    "--reset recommendations acknowledge",
    "--reset recommendations refresh",
    "recommendations --json acknowledge",
    "recommendations --json refresh",
    "--json --reset recommendations",
  ])("rejects inapplicable recommendations options: %s", async (args) => {
    await runCli(args.split(" "));
    const flag = args.includes("--reset") ? "--reset" : "--json";
    const message = `This recommendations command does not support parent option(s): ${flag}.`;
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    if (args.startsWith("--json")) {
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ ok: false, phase: "options", message }, null, 2),
      );
    } else {
      expect(runtime.log).not.toHaveBeenCalled();
    }
    expect(mocks.onboardRecommendationsCommand).not.toHaveBeenCalled();
    expect(mocks.acknowledgeOnboardRecommendationsCommand).not.toHaveBeenCalled();
    expect(mocks.refreshOnboardRecommendationsCommand).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    { args: [], installDaemon: undefined },
    { args: ["--install-daemon"], installDaemon: true },
    { args: ["--no-install-daemon"], installDaemon: false },
  ])("resolves daemon installation for $args", async ({ args, installDaemon }) => {
    await runCli(args);
    expect(setupWizardCommandMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ installDaemon }),
      runtime,
    );
    expect(setupWizardCommandMock.mock.calls[0]?.[0]).not.toHaveProperty("tailscaleResetOnExit");
  });

  it.each(["", "not-a-port", "70000"])("rejects invalid gateway port %s", async (port) => {
    await runCli(["--gateway-port", port]);
    expect(runtime.error).toHaveBeenCalledWith(
      "--gateway-port must be an integer between 1 and 65535.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting custom input flags with a JSON options error", async () => {
    await runCli(["--custom-image-input", "--custom-text-input", "--json"]);
    const message = "Use either --custom-image-input or --custom-text-input, not both.";
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, phase: "options", message }, null, 2),
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: "--json --modern --non-interactive",
      message: "Non-interactive setup requires explicit risk acknowledgement.",
    },
    {
      args: "--modern --no-install-daemon",
      message: "--modern cannot be combined with: --no-install-daemon.",
    },
  ])("rejects invalid modern options: $args", async ({ args, message }) => {
    await runCli(args.split(" "));
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    if (args.startsWith("--json")) {
      expect(runtime.log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        phase: "options",
        message: expect.stringContaining(message),
      });
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runSystemAgentWithInference).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    { args: "--modern --json", options: { json: true, interactive: true }, fallback: {} },
    {
      args: "--modern --non-interactive --accept-risk",
      options: { json: false, interactive: false },
      fallback: { acceptRisk: true },
    },
    {
      args: "--modern --workspace /tmp/work --accept-risk",
      options: { json: false, interactive: true, setupWorkspace: "/tmp/work" },
      fallback: { workspace: "/tmp/work", acceptRisk: true },
    },
  ])("routes inference-gated onboarding for $args", async ({ args, options, fallback }) => {
    await runCli(args.split(" "));
    expect(mocks.runSystemAgentWithInference).toHaveBeenCalledExactlyOnceWith(
      { yes: false, welcomeVariant: "onboarding", ...options },
      runtime,
      fallback,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });
});
