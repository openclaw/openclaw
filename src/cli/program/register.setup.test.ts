import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setupCommandMock = vi.fn();
const onboardCommandMock = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/setup.js", () => ({
  setupCommand: setupCommandMock,
}));

vi.mock("../../commands/onboard.js", () => ({
  onboardCommand: onboardCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerSetupCommand: typeof import("./register.setup.js").registerSetupCommand;

beforeAll(async () => {
  ({ registerSetupCommand } = await import("./register.setup.js"));
});

describe("registerSetupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommandMock.mockResolvedValue(undefined);
    onboardCommandMock.mockResolvedValue(undefined);
  });

  it("runs setup command by default", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws"]);

    expect(setupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/ws",
      }),
      runtime,
    );
    expect(onboardCommandMock).not.toHaveBeenCalled();
  });

  it("runs onboard command when --wizard is set", async () => {
    await runCli(["setup", "--wizard", "--mode", "remote", "--remote-url", "wss://example"]);

    expect(onboardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        remoteUrl: "wss://example",
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs onboard command when wizard-only flags are passed explicitly", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive"]);

    expect(onboardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        nonInteractive: true,
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("reports setup errors through runtime", async () => {
    setupCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
