import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  setupGemmaCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
const setupGemmaCommandMock = mocks.setupGemmaCommandMock;
const runtime = mocks.runtime;

vi.mock("../../commands/setup.js", () => ({
  setupCommand: mocks.setupCommandMock,
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../commands/setup-gemma.js", () => ({
  setupGemmaCommand: mocks.setupGemmaCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSetupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommandMock.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
    setupGemmaCommandMock.mockResolvedValue(undefined);
  });

  it("runs Gemma setup wizard by default", async () => {
    await runCli(["setup"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ advanced: false }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("runs Gemma setup wizard in advanced mode with --advanced", async () => {
    await runCli(["setup", "--advanced"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ advanced: true }),
      runtime,
    );
  });

  it("runs workspace-only setup with --workspace-only", async () => {
    await runCli(["setup", "--workspace-only", "--workspace", "/tmp/ws"]);

    expect(setupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/ws" }),
      runtime,
    );
    expect(setupGemmaCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when --wizard is set", async () => {
    await runCli(["setup", "--wizard", "--mode", "remote", "--remote-url", "wss://example"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        remoteUrl: "wss://example",
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupGemmaCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when wizard-only flags are passed explicitly", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        nonInteractive: true,
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("reports Gemma setup errors through runtime", async () => {
    setupGemmaCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
