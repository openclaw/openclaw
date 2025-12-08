import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const statusCommand = vi.fn();
const loginWeb = vi.fn();
const monitorWebProvider = vi.fn();
const logWebSelfId = vi.fn();
const waitForever = vi.fn();
const monitorTelegramProvider = vi.fn();
const startWebChatServer = vi.fn(async () => ({ port: 18788, token: null }));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/send.js", () => ({ sendCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../provider-web.js", () => ({
  loginWeb,
  monitorWebProvider,
}));
vi.mock("../telegram/monitor.js", () => ({
  monitorTelegramProvider,
}));
vi.mock("../webchat/server.js", () => ({
  startWebChatServer,
  getWebChatServer: () => null,
}));
vi.mock("./deps.js", () => ({
  createDefaultDeps: () => ({ waitForever }),
  logWebSelfId,
}));

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

  it("starts relay with heartbeat tuning", async () => {
    monitorWebProvider.mockResolvedValue(undefined);
    const program = buildProgram();
    await program.parseAsync(
      ["relay", "--web-heartbeat", "90", "--heartbeat-now"],
      {
        from: "user",
      },
    );
    expect(logWebSelfId).toHaveBeenCalled();
    expect(monitorWebProvider).toHaveBeenCalledWith(
      false,
      undefined,
      true,
      undefined,
      runtime,
      undefined,
      { heartbeatSeconds: 90, replyHeartbeatNow: true },
    );
  });

  it("runs relay heartbeat command", async () => {
    monitorWebProvider.mockResolvedValue(undefined);
    const originalExit = runtime.exit;
    runtime.exit = vi.fn();
    const program = buildProgram();
    await program.parseAsync(["relay:heartbeat"], { from: "user" });
    expect(logWebSelfId).toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    runtime.exit = originalExit;
  });

  it("runs telegram relay when token set", async () => {
    const program = buildProgram();
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "token123";
    await program.parseAsync(["relay:telegram"], { from: "user" });
    expect(monitorTelegramProvider).toHaveBeenCalled();
    process.env.TELEGRAM_BOT_TOKEN = prev;
  });

  it("runs status command", async () => {
    const program = buildProgram();
    await program.parseAsync(["status"], { from: "user" });
    expect(statusCommand).toHaveBeenCalled();
  });

  it("starts webchat server and prints json", async () => {
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["webchat", "--json"], { from: "user" });
    expect(startWebChatServer).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ port: 18788, token: null, basePath: "/webchat/", host: "127.0.0.1" }),
    );
  });
});
