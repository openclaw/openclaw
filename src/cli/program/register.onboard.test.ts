import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerOnboardCommand } from "./register.onboard.js";

const { acknowledge, recommendations, refresh, systemAgent, wizard, runtime } = vi.hoisted(() => ({
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
    {
      cliOption: "--local-embedding-only",
      description: "Consent to embedding model downloads",
      optionKey: "localEmbeddingOnly",
    },
  ],
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: wizard,
}));

vi.mock("../../commands/onboard-recommendations.js", () => ({
  acknowledgeOnboardRecommendationsCommand: acknowledge,
  onboardRecommendationsCommand: recommendations,
  refreshOnboardRecommendationsCommand: refresh,
}));

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
async function runCli(args: string[] | string) {
  await createProgram().parseAsync(
    ["onboard", ...(typeof args === "string" ? args.split(" ") : args)],
    { from: "user" },
  );
}
function optionsError(message: string) {
  return JSON.stringify(
    { ok: false, error: { type: "cli_error", message }, phase: "options", message },
    null,
    2,
  );
}
function expectNoRecommendations() {
  for (const command of [recommendations, acknowledge, refresh, wizard]) {
    expect(command).not.toHaveBeenCalled();
  }
}

beforeEach(() => vi.resetAllMocks());

describe("registered onboarding", () => {
  it("passes a plugin's boolean consent flag without string coercion", async () => {
    await runCli(["--non-interactive", "--accept-risk", "--local-embedding-only"]);
    expect(wizard).toHaveBeenCalledWith(
      expect.objectContaining({ localEmbeddingOnly: true }),
      runtime,
    );
  });
  it.each([
    {
      args: "recommendations --agent writer --json",
      target: recommendations,
      options: { agent: "writer", json: true },
    },
    {
      args: "recommendations acknowledge",
      target: acknowledge,
      options: { retry: undefined },
    },
  ])("routes $args", async ({ args, target, options }) => {
    await runCli(args.split(" "));
    expect(target).toHaveBeenCalledExactlyOnceWith(options, runtime);
    expect(wizard).not.toHaveBeenCalled();
  });

  it("preserves an explicitly blank leaf agent over its parent", async () => {
    await runCli(["recommendations", "--agent", "writer", "refresh", "--agent", ""]);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ agent: "" }, runtime);
  });

  it("inherits the parent agent instead of a leaf default", async () => {
    const program = createProgram();
    const recommendationGroup = program.commands
      .find((command) => command.name() === "onboard")
      ?.commands.find((command) => command.name() === "recommendations");
    const leaf = recommendationGroup?.commands.find((command) => command.name() === "refresh");
    if (!leaf) {
      throw new Error("Expected registered recommendations refresh command");
    }
    leaf.setOptionValueWithSource("agent", "analyst", "default");
    await program.parseAsync("onboard recommendations --agent writer refresh".split(" "), {
      from: "user",
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ agent: "writer" }, runtime);
  });

  it.each(["recommendations --json refresh", "--json --reset recommendations"])(
    "rejects inapplicable recommendations options: %s",
    async (args) => {
      await runCli(args);
      const flag = args.includes("--reset") ? "--reset" : "--json";
      const message = `This recommendations command does not support parent option(s): ${flag}.`;
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      if (args.startsWith("--json")) {
        expect(runtime.log).toHaveBeenCalledExactlyOnceWith(optionsError(message));
      } else {
        expect(runtime.log).not.toHaveBeenCalled();
      }
      expectNoRecommendations();
    },
  );

  it("resolves explicitly disabled daemon installation", async () => {
    await runCli("--no-install-daemon");
    expect(wizard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ installDaemon: false }),
      runtime,
    );
    expect(wizard.mock.calls[0]?.[0]).not.toHaveProperty("tailscaleResetOnExit");
  });

  it("rejects conflicting custom input flags with a JSON options error", async () => {
    await runCli(["--custom-image-input", "--custom-text-input", "--json"]);
    const message = "Use either --custom-image-input or --custom-text-input, not both.";
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).toHaveBeenCalledWith(optionsError(message));
    expect(wizard).not.toHaveBeenCalled();
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
    await runCli(args);
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    if (args.startsWith("--json")) {
      expect(runtime.log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: { type: "cli_error", message: expect.stringContaining(message) },
        phase: "options",
        message: expect.stringContaining(message),
      });
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(systemAgent).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
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
    await runCli(args);
    expect(systemAgent).toHaveBeenCalledExactlyOnceWith(
      { yes: false, welcomeVariant: "onboarding", ...options },
      runtime,
      fallback,
    );
    expect(wizard).not.toHaveBeenCalled();
  });
});
