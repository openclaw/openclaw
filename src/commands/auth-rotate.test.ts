import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../cli/test-runtime-capture.js";

const readConfigFileSnapshot = vi.fn();
const replaceConfigFile = vi.fn();
const setGatewayTokenIssuedAtNow = vi.fn();

vi.mock("./onboard-helpers.js", () => ({
  randomToken: vi.fn(() => "f".repeat(48)),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFile(...args),
}));

vi.mock("../gateway/token-expiry-state.js", () => ({
  setGatewayTokenIssuedAtNow: (...args: unknown[]) => setGatewayTokenIssuedAtNow(...args),
}));

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

const { runGatewayAuthRotateCommand } = await import("./auth-rotate.js");

describe("runGatewayAuthRotateCommand", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdoutWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    stdoutWriteMock = vi.fn(() => true);
    process.stdout.write = stdoutWriteMock as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("exits when config is missing", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({ exists: false });

    await expect(runGatewayAuthRotateCommand(defaultRuntime)).rejects.toThrow("__exit__:1");

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("exits when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({ exists: true, valid: false });

    await expect(runGatewayAuthRotateCommand(defaultRuntime)).rejects.toThrow("__exit__:1");

    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("exits when gateway.auth.token is SecretRef-managed", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      hash: "h1",
      config: {},
      sourceConfig: {
        gateway: {
          auth: {
            token: { source: "env" as const, provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
      },
    });

    await expect(runGatewayAuthRotateCommand(defaultRuntime)).rejects.toThrow("__exit__:1");

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot rotate token: gateway.auth.token is managed via SecretRef"),
    );
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("persists a new token and records issue time for plaintext config", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      hash: "h1",
      config: {},
      sourceConfig: {
        gateway: { auth: { mode: "token" as const, token: "old-plaintext" } },
      },
    });
    replaceConfigFile.mockResolvedValueOnce({} as never);

    await runGatewayAuthRotateCommand(defaultRuntime);

    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    const call = replaceConfigFile.mock.calls[0]?.[0];
    expect(call?.nextConfig?.gateway?.auth?.token).toBe("f".repeat(48));
    expect(call?.nextConfig?.gateway?.auth?.mode).toBe("token");
    expect(setGatewayTokenIssuedAtNow).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(stdoutWriteMock).toHaveBeenCalled();
  });
});
