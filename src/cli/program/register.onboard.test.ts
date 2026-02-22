import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const onboardCommandMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli: () => "token|oauth",
}));

vi.mock("../../commands/onboard-provider-auth-flags.js", () => ({
  ONBOARD_PROVIDER_AUTH_FLAGS: [] as Array<{ cliOption: string; description: string }>,
}));

vi.mock("../../commands/onboard.js", () => ({
  onboardCommand: onboardCommandMock,
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
    onboardCommandMock.mockResolvedValue(undefined);
  });

  it("defaults installDaemon to undefined when no daemon flags are provided", async () => {
    await runCli(["onboard"]);

    expect(onboardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installDaemon: undefined,
      }),
      runtime,
    );
  });

  it("sets installDaemon from explicit install flags and prioritizes --skip-daemon", async () => {
    await runCli(["onboard", "--install-daemon"]);
    expect(onboardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        installDaemon: true,
      }),
      runtime,
    );

    await runCli(["onboard", "--no-install-daemon"]);
    expect(onboardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );

    await runCli(["onboard", "--install-daemon", "--skip-daemon"]);
    expect(onboardCommandMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );
  });

  it("parses numeric gateway port and drops invalid values", async () => {
    await runCli(["onboard", "--gateway-port", "18789"]);
    expect(onboardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        gatewayPort: 18789,
      }),
      runtime,
    );

    await runCli(["onboard", "--gateway-port", "nope"]);
    expect(onboardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gatewayPort: undefined,
      }),
      runtime,
    );
  });

  it("reports errors via runtime on onboard command failures", async () => {
    onboardCommandMock.mockRejectedValueOnce(new Error("onboard failed"));

    await runCli(["onboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: onboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
