import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeIMessage } from "./probe.js";

const detectBinaryMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBinary: (...args: unknown[]) => detectBinaryMock(...args),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: (...args: unknown[]) => createIMessageRpcClientMock(...args),
}));

beforeEach(() => {
  detectBinaryMock.mockReset().mockResolvedValue(true);
  runCommandWithTimeoutMock.mockReset().mockResolvedValue({
    stdout: "",
    stderr: 'unknown command "rpc" for "imsg"',
    code: 1,
    signal: null,
    killed: false,
  });
  createIMessageRpcClientMock.mockReset();
});

describe("probeIMessage", () => {
  it("marks unknown rpc subcommand as fatal", async () => {
    const result = await probeIMessage(1000, { cliPath: "imsg" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("marks permission denied probe failures as fatal", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });
    createIMessageRpcClientMock.mockResolvedValueOnce({
      request: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "imsg permission denied for /Users/alice/Library/Messages/chat.db (authorization denied (code: 23))",
          ),
        ),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const result = await probeIMessage(1000, { cliPath: "imsg-permission" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toContain("imsg permission denied");
  });
});
