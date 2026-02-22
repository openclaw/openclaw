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

  it("runs message command with required options", async () => {
    await expect(
      runProgram(["message", "send", "--target", "+1", "--message", "hi"]),
    ).rejects.toThrow("exit");
    expect(messageCommand).toHaveBeenCalled();
  });

  it("registers memory + status commands", () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
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

  it("passes representative auth flags to onboard", async () => {
    await runProgram([
      "onboard",
      "--non-interactive",
      "--auth-choice",
      "openrouter-api-key",
      "--openrouter-api-key",
      "sk-openrouter-test",
    ]);

    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "openrouter-api-key",
        openrouterApiKey: "sk-openrouter-test",
      }),
      runtime,
    );
  });
});
