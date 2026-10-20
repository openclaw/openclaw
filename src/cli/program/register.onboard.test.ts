import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
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
  resolveProviderOnboardAuthFlags: () =>
    [
      ["--openai-api-key <key>", "openaiApiKey"],
      ["--openai-api-key <key>", "anotherProviderApiKey"],
      ["--local-embedding-only", "localEmbeddingOnly"],
    ].map(([cliOption, optionKey]) => ({ cliOption, optionKey, description: "Fixture flag" })),
}));

// mock-isolation: CLI parsing captures command dispatch without running onboarding, inference, or recommendation state.
vi.mock("../../commands/onboard.js", () => ({ setupWizardCommand: wizard }));

// mock-isolation: CLI parsing captures command dispatch without running onboarding, inference, or recommendation state.
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
async function runCli(args: string[] | string) {
  const argv = typeof args === "string" ? args.split(" ") : args;
  await createProgram().parseAsync(["onboard", ...argv], { from: "user" });
}
function optionsError(message: string) {
  const error = { type: "cli_error", message };
  return JSON.stringify({ ok: false, error, phase: "options", message }, null, 2);
}
function expectCall(target: typeof wizard, ...args: unknown[]) {
  expect(target).toHaveBeenCalledExactlyOnceWith(...args);
}

beforeEach(() => vi.resetAllMocks());

it("passes a plugin's boolean consent flag without string coercion", async () => {
  await runCli(["--non-interactive", "--accept-risk", "--local-embedding-only"]);
  expect(wizard).toHaveBeenCalledWith(
    expect.objectContaining({ localEmbeddingOnly: true }),
    runtime,
  );
});
it.each([
  ["recommendations --agent writer --json", recommendations, { agent: "writer", json: true }],
  ["recommendations acknowledge", acknowledge, { retry: undefined }],
] as const)("routes %s", async (args, target, options) => {
  await runCli(args.split(" "));
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
  if (json && partial) {
    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: { type: "cli_error", message: expected },
      phase: "options",
      message: expected,
    });
  } else if (json) {
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(optionsError(message));
  } else {
    expect(runtime.log).not.toHaveBeenCalled();
  }
  for (const command of [recommendations, acknowledge, refresh, wizard, systemAgent]) {
    expect(command).not.toHaveBeenCalled();
  }
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
