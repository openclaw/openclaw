import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setupWizardCommandMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/auth-choice-options.static.js", () => ({
  formatStaticAuthChoiceChoicesForCli: () => "token|oauth",
}));

vi.mock("../../commands/auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli: () => "token|oauth|openai-api-key",
}));

vi.mock("../../commands/onboard-core-auth-flags.js", () => ({
  CORE_ONBOARD_AUTH_FLAGS: [
    {
      cliOption: "--mistral-api-key <key>",
      description: "Mistral API key",
      optionKey: "mistralApiKey",
    },
  ] as Array<{ cliOption: string; description: string; optionKey: string }>,
}));

vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderOnboardAuthFlags: () => [
    {
      cliOption: "--openai-api-key <key>",
      description: "OpenAI API key",
      optionKey: "openaiApiKey",
    },
  ],
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: setupWizardCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerOnboardCommand: typeof import("./register.onboard.js").registerOnboardCommand;

beforeAll(async () => {
  ({ registerOnboardCommand } = await import("./register.onboard.js"));
});

describe("registerOnboardCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerOnboardCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupWizardCommandMock.mockResolvedValue(undefined);
  });

  it("defaults installDaemon to undefined when no daemon flags are provided", async () => {
    await runCli(["onboard"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installDaemon: undefined,
      }),
      runtime,
    );
  });

  it("sets installDaemon from explicit install flags and prioritizes --skip-daemon", async () => {
    await runCli(["onboard", "--install-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        installDaemon: true,
      }),
      runtime,
    );

    await runCli(["onboard", "--no-install-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );

    await runCli(["onboard", "--install-daemon", "--skip-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );
  });

  it("parses numeric gateway port and drops invalid values", async () => {
    await runCli(["onboard", "--gateway-port", "18789"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        gatewayPort: 18789,
      }),
      runtime,
    );

    await runCli(["onboard", "--gateway-port", "nope"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gatewayPort: undefined,
      }),
      runtime,
    );
  });

  it("forwards --reset-scope to setup wizard options", async () => {
    await runCli(["onboard", "--reset", "--reset-scope", "full"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reset: true,
        resetScope: "full",
      }),
      runtime,
    );
  });

  it("parses --mistral-api-key and forwards mistralApiKey", async () => {
    await runCli(["onboard", "--mistral-api-key", "sk-mistral-test"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mistralApiKey: "sk-mistral-test", // pragma: allowlist secret
      }),
      runtime,
    );
  });

  it("forwards --gateway-token-ref-env", async () => {
    await runCli(["onboard", "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN",
      }),
      runtime,
    );
  });

  it("forwards Azure OpenAI version/base/model flags", async () => {
    await runCli([
      "onboard",
      "--azure-openai-base-url",
      "https://example.openai.azure.com",
      "--azure-openai-model-id",
      "gpt-5.4",
      "--azure-openai-api-version",
      "2025-04-01-preview",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        azureOpenaiBaseUrl: "https://example.openai.azure.com",
        azureOpenaiModelId: "gpt-5.4",
        azureOpenaiApiVersion: "2025-04-01-preview",
      }),
      runtime,
    );
  });

  it("reports errors via runtime on setup wizard command failures", async () => {
    setupWizardCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["onboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
