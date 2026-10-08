// QA Lab MCP gateway transport tests cover script-backed MCP client state.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeApprovePendingBridgePairing, type GatewayRpcClient } from "./mcp-channels.fixture.ts";
import {
  connectMcpClientWithPairingReconnect,
  connectMcpWithTimeout,
  createMcpClientTempState,
  type McpClientTempState,
} from "./mcp-client-temp-state.fixture.ts";

describe("MCP gateway transport fixture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { error: "unknown requestId", reconnect: false },
    { error: undefined, reconnect: true },
    { error: "missing scope: operator.pairing", reconnect: undefined },
  ])("settles a listed pairing after approval returns $error", async ({ error, reconnect }) => {
    const gateway: GatewayRpcClient = {
      auth: { role: "operator", scopes: ["operator.admin"] },
      events: [],
      close: async () => {},
      async request<T>(method: string): Promise<T> {
        if (method === "device.pair.list") {
          return { pending: [{ requestId: "bridge-request", role: "operator" }] } as T;
        }
        if (error) {
          throw new Error(error);
        }
        return {} as T;
      },
    };
    const result = maybeApprovePendingBridgePairing(gateway);
    if (reconnect === undefined) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toBe(reconnect);
    }
  });

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

      expect(existsSync(first.root)).toBe(false);
      expect(existsSync(second.root)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("reuses one MCP temp state across the pairing reconnect path", async () => {
    const tempState = createMcpClientTempState({ gatewayToken: "pairing-token" });
    const firstHandle = {
      cleanup: vi.fn(),
      client: { close: vi.fn(async () => undefined) },
      transport: { close: vi.fn(async () => undefined) },
    };
    const secondHandle = {
      cleanup: vi.fn(),
      client: { close: vi.fn(async () => undefined) },
      transport: { close: vi.fn(async () => undefined) },
    };
    const connectCalls: McpClientTempState[] = [];
    const connect = vi.fn(async (state: McpClientTempState) => {
      connectCalls.push(state);
      return connectCalls.length === 1 ? firstHandle : secondHandle;
    });

    try {
      await expect(
        connectMcpClientWithPairingReconnect({
          connect,
          maybeApprovePairing: async () => true,
          tempState,
        }),
      ).resolves.toBe(secondHandle);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(connectCalls).toEqual([tempState, tempState]);
      expect(firstHandle.client.close).toHaveBeenCalledOnce();
      expect(firstHandle.transport.close).toHaveBeenCalledOnce();
      expect(firstHandle.cleanup).toHaveBeenCalledOnce();
      expect(secondHandle.cleanup).not.toHaveBeenCalled();
    } finally {
      tempState.cleanup();
    }
  });

  it("cleans up the first MCP client when pairing approval fails", async () => {
    const tempState = createMcpClientTempState({ gatewayToken: "pairing-token" });
    const handle = {
      cleanup: vi.fn(),
      client: { close: vi.fn(async () => undefined) },
      transport: { close: vi.fn(async () => undefined) },
    };
    const failure = new Error("pairing approval failed");

    try {
      await expect(
        connectMcpClientWithPairingReconnect({
          connect: async () => handle,
          maybeApprovePairing: async () => {
            throw failure;
          },
          tempState,
        }),
      ).rejects.toBe(failure);

      expect(handle.client.close).toHaveBeenCalledOnce();
      expect(handle.transport.close).toHaveBeenCalledOnce();
      expect(handle.cleanup).toHaveBeenCalledOnce();
    } finally {
      tempState.cleanup();
    }
  });

  it("resolves when the MCP client connects before the timeout", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
    };
    const transport = {
      close: vi.fn(),
    };

    await expect(connectMcpWithTimeout(client, transport, 1000)).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledWith(transport);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("closes the transport when MCP initialize hangs", async () => {
    vi.useFakeTimers();
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("waits for timed-out transport cleanup before rejecting", async () => {
    vi.useFakeTimers();
    let closeSettled = false;
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              closeSettled = true;
              resolve();
            }, 25);
          }),
      ),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(closeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(closeSettled).toBe(true);
  });

  it("keeps the original timeout error when cleanup rejects", async () => {
    vi.useFakeTimers();
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
