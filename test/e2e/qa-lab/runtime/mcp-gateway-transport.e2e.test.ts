import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  connectMcpClientWithPairingReconnect,
  connectMcpWithTimeout,
  createMcpClientTempState,
  type McpClientTempState,
} from "./mcp-client-temp-state.fixture.ts";

function createHandle() {
  return {
    cleanup: vi.fn(),
    client: { close: vi.fn(async () => undefined) },
    transport: { close: vi.fn(async () => undefined) },
  };
}
afterEach(() => vi.useRealTimers());

it("creates unique client temp state and removes token files on cleanup", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-mcp-harness-test-"));
  try {
    const first = createMcpClientTempState({ gatewayToken: "first-token", tempRoot });
    const second = createMcpClientTempState({ gatewayToken: "second-token", tempRoot });
    expect(first.root).not.toBe(second.root);
    expect(first.stateDir).toBe(path.join(first.root, "state"));
    expect(readFileSync(first.tokenFile, "utf8")).toBe("first-token\n");
    expect(statSync(first.tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(second.tokenFile, "utf8")).toBe("second-token\n");
    first.cleanup();
    second.cleanup();
    expect([existsSync(first.root), existsSync(second.root)]).toEqual([false, false]);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

it.each([true, false])(
  "cleans the first MCP client on pairing approval (succeeds=%s)",
  async (approved) => {
    const tempState = createMcpClientTempState({ gatewayToken: "pairing-token" });
    const first = createHandle();
    const second = createHandle();
    const failure = new Error("pairing approval failed");
    const connect = vi
      .fn<(state: McpClientTempState) => Promise<ReturnType<typeof createHandle>>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    try {
      const result = connectMcpClientWithPairingReconnect({
        connect,
        tempState,
        maybeApprovePairing: async () => {
          if (!approved) {
            throw failure;
          }
          return true;
        },
      });
      if (approved) {
        await expect(result).resolves.toBe(second);
        expect(connect.mock.calls).toEqual([[tempState], [tempState]]);
        expect(second.cleanup).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toBe(failure);
      }
      for (const close of [first.client.close, first.transport.close, first.cleanup]) {
        expect(close).toHaveBeenCalledOnce();
      }
    } finally {
      tempState.cleanup();
    }
  },
);

it.each([false, true])(
  "preserves the timeout after transport cleanup (rejects=%s)",
  async (rejects) => {
    vi.useFakeTimers();
    let closeSettled = false;
    const client = { connect: vi.fn(() => new Promise<void>(() => {})) };
    const transport = {
      close: vi.fn(async () => {
        if (rejects) {
          throw new Error("close failed");
        }
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            closeSettled = true;
            resolve();
          }, 25);
        });
      }),
    };
    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.close).toHaveBeenCalledOnce();
    if (!rejects) {
      expect(closeSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(25);
      expect(closeSettled).toBe(true);
    }
    await rejection;
  },
);
