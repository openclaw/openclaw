import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const loadConfig = vi.fn();
const runCommandWithTimeout = vi.fn();
const qrGenerate = vi.fn((_input, _opts, cb: (output: string) => void) => {
  cb("ASCII-QR");
});

vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../config/config.js", () => ({ loadConfig }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout }));
vi.mock("qrcode-terminal", () => ({
  default: {
    generate: qrGenerate,
  },
}));

const { registerQrCli } = await import("./qr-cli.js");

describe("registerQrCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints setup code only when requested", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    const program = new Command();
    registerQrCli(program);

    await program.parseAsync(["qr", "--setup-code-only"], { from: "user" });

    const expected = encodePairingSetupCode({
      url: "ws://gateway.local:18789",
      token: "tok",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
    expect(qrGenerate).not.toHaveBeenCalled();
  });

  it("renders ASCII QR by default", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    const program = new Command();
    registerQrCli(program);

    await program.parseAsync(["qr"], { from: "user" });

    expect(qrGenerate).toHaveBeenCalledTimes(1);
    const output = runtime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Pairing QR");
    expect(output).toContain("ASCII-QR");
    expect(output).toContain("Gateway:");
    expect(output).toContain("openclaw devices approve <requestId>");
  });

  it("accepts --token override when config has no auth", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
      },
    });

    const program = new Command();
    registerQrCli(program);

    await program.parseAsync(["qr", "--setup-code-only", "--token", "override-token"], {
      from: "user",
    });

    const expected = encodePairingSetupCode({
      url: "ws://gateway.local:18789",
      token: "override-token",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });

  it("exits with error when gateway config is not pairable", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    const program = new Command();
    registerQrCli(program);

    await expect(program.parseAsync(["qr"], { from: "user" })).rejects.toThrow("exit");

    const output = runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("only bound to loopback");
  });

  it("uses gateway.remote.url when --remote is set (ignores device-pair publicUrl)", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        remote: { url: "wss://remote.example.com:444" },
        auth: { mode: "token", token: "tok" },
      },
      plugins: {
        entries: {
          "device-pair": {
            config: {
              publicUrl: "ws://plugin.example.com:18789",
            },
          },
        },
      },
    });

    const program = new Command();
    registerQrCli(program);

    await program.parseAsync(["qr", "--setup-code-only", "--remote"], { from: "user" });

    const expected = encodePairingSetupCode({
      url: "wss://remote.example.com:444",
      token: "tok",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });

  it("errors when --remote is set but no remote URL is configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    const program = new Command();
    registerQrCli(program);

    await expect(program.parseAsync(["qr", "--remote"], { from: "user" })).rejects.toThrow("exit");

    const output = runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("qr --remote requires");
  });
});
