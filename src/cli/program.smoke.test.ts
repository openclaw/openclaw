import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureCommand,
  ensureConfigReady,
  installBaseProgramMocks,
  installSmokeProgramMocks,
  messageCommand,
  onboardCommand,
  runTui,
  runtime,
  setupCommand,
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
  ])("message command: $label", async ({ argv }) => {
    await expect(runProgram(argv)).rejects.toThrow("exit");
    expect(messageCommand).toHaveBeenCalled();
  });

  it("registers memory + status commands", () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("memory");
    expect(names).toContain("status");
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
  ])("tui command: $label", async ({ argv, expectedTimeoutMs, expectedWarning }) => {
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
  ])("setup command: $label", async ({ argv, expectSetupCalled, expectOnboardCalled }) => {
    await runProgram(argv);
    expect(setupCommand).toHaveBeenCalledTimes(expectSetupCalled ? 1 : 0);
    expect(onboardCommand).toHaveBeenCalledTimes(expectOnboardCalled ? 1 : 0);
  });

  it("passes auth api keys to onboard", async () => {
    const cases = [
      {
        authChoice: "openrouter-api-key",
        flag: "--openrouter-api-key",
        key: "sk-openrouter-test",
        field: "openrouterApiKey",
      },
      {
        authChoice: "moonshot-api-key-cn",
        flag: "--moonshot-api-key",
        key: "sk-moonshot-cn-test",
        field: "moonshotApiKey",
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
});
