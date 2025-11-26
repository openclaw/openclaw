import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const statusCommand = vi.fn();
const webhookCommand = vi.fn().mockResolvedValue(undefined);
const ensureTwilioEnv = vi.fn();
const loginWeb = vi.fn();
const monitorWebProvider = vi.fn();
const pickProvider = vi.fn();
const monitorTwilio = vi.fn();
const logTwilioFrom = vi.fn();
const logWebSelfId = vi.fn();
const waitForever = vi.fn();
const spawnRelayTmux = vi.fn().mockResolvedValue("warelay-relay");

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/send.js", () => ({ sendCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/webhook.js", () => ({ webhookCommand }));
vi.mock("../env.js", () => ({ ensureTwilioEnv }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../provider-web.js", () => ({
  loginWeb,
  monitorWebProvider,
  pickProvider,
}));
vi.mock("./deps.js", () => ({
  createDefaultDeps: () => ({ waitForever }),
  logTwilioFrom,
  logWebSelfId,
  monitorTwilio,
}));
vi.mock("./relay_tmux.js", () => ({ spawnRelayTmux }));

const { buildProgram } = await import("./program.js");

describe("cli program", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs send with required options", async () => {
    const program = buildProgram();
    await program.parseAsync(["send", "--to", "+1", "--message", "hi"], {
      from: "user",
    });
    expect(sendCommand).toHaveBeenCalled();
  });

  it("rejects invalid relay provider", async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(["relay", "--provider", "bogus"], { from: "user" }),
    ).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      "--provider must be auto, web, or twilio",
    );
  });

  it("falls back to twilio when web relay fails", async () => {
    pickProvider.mockResolvedValue("web");
    monitorWebProvider.mockRejectedValue(new Error("no web"));
    const program = buildProgram();
    await expect(
      program.parseAsync(
        ["relay", "--provider", "auto", "--interval", "2", "--lookback", "1"],
        { from: "user" },
      ),
    ).rejects.toThrow("exit");
    expect(logWebSelfId).toHaveBeenCalled();
    expect(ensureTwilioEnv).not.toHaveBeenCalled();
    expect(monitorTwilio).not.toHaveBeenCalled();
  });

  it("runs relay tmux attach command", async () => {
    const originalIsTTY = process.stdout.isTTY;
    (process.stdout as typeof process.stdout & { isTTY?: boolean }).isTTY =
      true;

    const program = buildProgram();
    await program.parseAsync(["relay:tmux:attach"], { from: "user" });
    expect(spawnRelayTmux).toHaveBeenCalledWith(
      "pnpm warelay relay --verbose",
      true,
      false,
    );

    (process.stdout as typeof process.stdout & { isTTY?: boolean }).isTTY =
      originalIsTTY;
  });

  it("runs relay heartbeat command", async () => {
    pickProvider.mockResolvedValue("web");
    monitorWebProvider.mockResolvedValue(undefined);
    const originalExit = runtime.exit;
    runtime.exit = vi.fn();
    const program = buildProgram();
    await program.parseAsync(["relay:heartbeat"], { from: "user" });
    expect(logWebSelfId).toHaveBeenCalled();
    expect(monitorWebProvider).toHaveBeenCalledWith(
      false,
      undefined,
      true,
      undefined,
      runtime,
      undefined,
      { replyHeartbeatNow: true },
    );
    expect(runtime.exit).not.toHaveBeenCalled();
    runtime.exit = originalExit;
  });

  it("runs relay heartbeat tmux helper", async () => {
    const program = buildProgram();
    await program.parseAsync(["relay:heartbeat:tmux"], { from: "user" });
    const shouldAttach = Boolean(process.stdout.isTTY);
    expect(spawnRelayTmux).toHaveBeenCalledWith(
      "pnpm warelay relay --verbose --heartbeat-now",
      shouldAttach,
    );
  });
});
