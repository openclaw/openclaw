import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureCommand,
  ensureConfigReady,
  installBaseProgramMocks,
  installSmokeProgramMocks,
  messageCommand,
  onboardCommand,
  runChannelLogin,
  runChannelLogout,
  runTui,
  runtime,
  setupCommand,
  statusCommand,
} from "./program.test-mocks.js";

installBaseProgramMocks();
installSmokeProgramMocks();

const { buildProgram } = await import("./program.js");

describe("cli program (smoke)", () => {
  function createProgram() {
    return buildProgram();
  }

  async function runProgram(argv: string[]) {
    const program = createProgram();
    await program.parseAsync(argv, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
    ensureConfigReady.mockResolvedValue(undefined);
  });

  it.each([
    {
      label: "runs message with required options",
      argv: ["message", "send", "--target", "+1", "--message", "hi"],
    },
    {
      label: "runs message react with signal author fields",
      argv: [
        "message",
        "react",
        "--channel",
        "signal",
        "--target",
        "signal:group:abc123",
        "--message-id",
        "1737630212345",
        "--emoji",
        "✅",
        "--target-author-uuid",
        "123e4567-e89b-12d3-a456-426614174000",
      ],
    },
  ])("$label", async ({ argv }) => {
    await expect(runProgram(argv)).rejects.toThrow("exit");
    expect(messageCommand).toHaveBeenCalled();
  });

  it("runs status command", async () => {
    await runProgram(["status"]);
    expect(statusCommand).toHaveBeenCalled();
  });

  it("registers memory command", () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("memory");
  });

  it.each([
    {
      label: "runs tui without overriding timeout",
      argv: ["tui"],
      expectedTimeoutMs: undefined,
      expectedWarning: undefined,
    },
    {
      label: "runs tui with explicit timeout override",
      argv: ["tui", "--timeout-ms", "45000"],
      expectedTimeoutMs: 45000,
      expectedWarning: undefined,
    },
    {
      label: "warns and ignores invalid tui timeout override",
      argv: ["tui", "--timeout-ms", "nope"],
      expectedTimeoutMs: undefined,
      expectedWarning: 'warning: invalid --timeout-ms "nope"; ignoring',
    },
  ])("$label", async ({ argv, expectedTimeoutMs, expectedWarning }) => {
    await runProgram(argv);
    if (expectedWarning) {
      expect(runtime.error).toHaveBeenCalledWith(expectedWarning);
    }
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expectedTimeoutMs }));
  });

  it("runs config alias as configure", async () => {
    await runProgram(["config"]);
    expect(configureCommand).toHaveBeenCalled();
  });

  it.each([
    {
      label: "runs setup without wizard flags",
      argv: ["setup"],
      expectSetupCalled: true,
      expectOnboardCalled: false,
    },
    {
      label: "runs setup wizard when wizard flags are present",
      argv: ["setup", "--remote-url", "ws://example"],
      expectSetupCalled: false,
      expectOnboardCalled: true,
    },
  ])("$label", async ({ argv, expectSetupCalled, expectOnboardCalled }) => {
    await runProgram(argv);
    expect(setupCommand).toHaveBeenCalledTimes(expectSetupCalled ? 1 : 0);
    expect(onboardCommand).toHaveBeenCalledTimes(expectOnboardCalled ? 1 : 0);
  });

  it("passes auth api keys to onboard", async () => {
    const cases = [
      {
        authChoice: "opencode-zen",
        flag: "--opencode-zen-api-key",
        key: "sk-opencode-zen-test",
        field: "opencodeZenApiKey",
      },
      {
        authChoice: "openrouter-api-key",
        flag: "--openrouter-api-key",
        key: "sk-openrouter-test",
        field: "openrouterApiKey",
      },
      {
        authChoice: "moonshot-api-key",
        flag: "--moonshot-api-key",
        key: "sk-moonshot-test",
        field: "moonshotApiKey",
      },
      {
        authChoice: "together-api-key",
        flag: "--together-api-key",
        key: "sk-together-test",
        field: "togetherApiKey",
      },
      {
        authChoice: "moonshot-api-key-cn",
        flag: "--moonshot-api-key",
        key: "sk-moonshot-cn-test",
        field: "moonshotApiKey",
      },
      {
        authChoice: "kimi-code-api-key",
        flag: "--kimi-code-api-key",
        key: "sk-kimi-code-test",
        field: "kimiCodeApiKey",
      },
      {
        authChoice: "synthetic-api-key",
        flag: "--synthetic-api-key",
        key: "sk-synthetic-test",
        field: "syntheticApiKey",
      },
      {
        authChoice: "zai-api-key",
        flag: "--zai-api-key",
        key: "sk-zai-test",
        field: "zaiApiKey",
      },
    ] as const;

    for (const entry of cases) {
      await runProgram([
        "onboard",
        "--non-interactive",
        "--auth-choice",
        entry.authChoice,
        entry.flag,
        entry.key,
      ]);
      expect(onboardCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          nonInteractive: true,
          authChoice: entry.authChoice,
          [entry.field]: entry.key,
        }),
        runtime,
      );
      onboardCommand.mockClear();
    }
  });

  it("passes custom provider flags to onboard", async () => {
    await runProgram([
      "onboard",
      "--non-interactive",
      "--auth-choice",
      "custom-api-key",
      "--custom-base-url",
      "https://llm.example.com/v1",
      "--custom-api-key",
      "sk-custom-test",
      "--custom-model-id",
      "foo-large",
      "--custom-provider-id",
      "my-custom",
      "--custom-compatibility",
      "anthropic",
    ]);

    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "custom-api-key",
        customBaseUrl: "https://llm.example.com/v1",
        customApiKey: "sk-custom-test",
        customModelId: "foo-large",
        customProviderId: "my-custom",
        customCompatibility: "anthropic",
      }),
      runtime,
    );
  });

  it.each([
    {
      label: "runs channels login",
      argv: ["channels", "login", "--account", "work"],
      expectCall: () =>
        expect(runChannelLogin).toHaveBeenCalledWith(
          { channel: undefined, account: "work", verbose: false },
          runtime,
        ),
    },
    {
      label: "runs channels logout",
      argv: ["channels", "logout", "--account", "work"],
      expectCall: () =>
        expect(runChannelLogout).toHaveBeenCalledWith(
          { channel: undefined, account: "work" },
          runtime,
        ),
    },
  ])("$label", async ({ argv, expectCall }) => {
    await runProgram(argv);
    expectCall();
  });
});
