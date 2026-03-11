import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureCommand,
  ensureConfigReady,
  installBaseProgramMocks,
  installSmokeProgramMocks,
  onboardCommand,
  runTui,
  runtime,
  setupCommand,
} from "./program.test-mocks.js";

installBaseProgramMocks();
installSmokeProgramMocks();

vi.mock("./config-cli.js", () => ({
  registerConfigCli: (program: {
    command: (name: string) => { action: (fn: () => unknown) => void };
  }) => {
    program.command("config").action(() => configureCommand({}, runtime));
  },
  runConfigGet: vi.fn(),
  runConfigUnset: vi.fn(),
}));

const { buildProgram } = await import("./program.js");

describe("cli program (smoke)", () => {
  let program = createProgram();

  function createProgram() {
    return buildProgram();
  }

  async function runProgram(argv: string[]) {
    await program.parseAsync(argv, { from: "user" });
  }

  beforeAll(() => {
    program = createProgram();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
    ensureConfigReady.mockResolvedValue(undefined);
  });

  it("registers memory + status commands", () => {
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("message");
    expect(names).toContain("memory");
    expect(names).toContain("status");
  });

  it("runs tui with explicit timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "45000"]);
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45000 }));
  });

  it("warns and ignores invalid tui timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: undefined }));
  });

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommand).not.toHaveBeenCalled();
    expect(onboardCommand).toHaveBeenCalledTimes(1);
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
      {
        authChoice: "amazon-nova-api-key",
        flag: "--nova-api-key",
        key: "sk-nova-test",
        field: "novaApiKey",
      },
    ] as const;

    for (const entry of cases) {
      const program = buildProgram();
      await program.parseAsync(
        ["onboard", "--non-interactive", "--auth-choice", entry.authChoice, entry.flag, entry.key],
        { from: "user" },
      );
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
    const program = buildProgram();
    await program.parseAsync(
      [
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
      ],
      { from: "user" },
    );

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

  it("runs channels login", async () => {
    const program = buildProgram();
    await program.parseAsync(["channels", "login", "--account", "work"], {
      from: "user",
    });
    expect(runChannelLogin).toHaveBeenCalledWith(
      { channel: undefined, account: "work", verbose: false },
      runtime,
    );
  });

  it("runs channels logout", async () => {
    const program = buildProgram();
    await program.parseAsync(["channels", "logout", "--account", "work"], {
      from: "user",
    });
    expect(runChannelLogout).toHaveBeenCalledWith({ channel: undefined, account: "work" }, runtime);
  });
});
