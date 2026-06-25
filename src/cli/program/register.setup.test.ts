// Register setup tests cover setup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
const runtime = mocks.runtime;

function lastWizardOptions(): Record<string, unknown> | undefined {
  const calls = setupWizardCommandMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../commands/setup.js", () => ({
  setupCommand: mocks.setupCommandMock,
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
  });

  it("runs onboarding by default", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.workspace).toBe("/tmp/ws");
    expect(lastWizardOptions()?.installDaemon).toBeUndefined();
  });

  it("preserves baseline setup for a bare --skip-ui invocation", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws", "--skip-ui"]);

    expect(setupCommandMock).toHaveBeenCalledWith({ workspace: "/tmp/ws" }, runtime);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("keeps --wizard as a compatibility flag", async () => {
    await runCli(["setup", "--wizard"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.flow).toBe("advanced");
  });

  it("keeps an explicit flow when --wizard is also present", async () => {
    await runCli(["setup", "--wizard", "--flow", "quickstart"]);

    expect(lastWizardOptions()?.flow).toBe("quickstart");
  });

  it("forwards onboarding flags", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive", "--accept-risk"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.nonInteractive).toBe(true);
    expect(lastWizardOptions()?.acceptRisk).toBe(true);
  });

  it("forwards migration import flags", async () => {
    await runCli([
      "setup",
      "--import-from",
      "hermes",
      "--import-source",
      "/tmp/hermes",
      "--import-secrets",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.importFrom).toBe("hermes");
    expect(lastWizardOptions()?.importSource).toBe("/tmp/hermes");
    expect(lastWizardOptions()?.importSecrets).toBe(true);
  });

  it("reports setup errors through runtime", async () => {
    setupWizardCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
