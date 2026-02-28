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

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommand).not.toHaveBeenCalled();
    expect(onboardCommand).toHaveBeenCalledTimes(1);
  });
});
