// QA Lab MCP gateway transport tests cover script-backed MCP client state.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectMcpClientWithPairingReconnect,
  connectMcpWithTimeout,
  createMcpClientTempState,
  maybeApprovePendingBridgePairing,
  type McpClientTempState,
} from "./mcp-client-temp-state.fixture.ts";

describe("MCP gateway transport fixture", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it.each([false, true])(
    "reuses one MCP temp state after pairing (auto-approved: %s)",
    async (autoApproved) => {
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
      const request = vi
        .fn<Parameters<typeof maybeApprovePendingBridgePairing>[0]["request"]>()
        .mockResolvedValueOnce({
          pending: [{ requestId: "pair-request", deviceId: "bridge-device", role: "operator" }],
        });
      if (autoApproved) {
        request
          .mockRejectedValueOnce(new Error("unknown requestId"))
          .mockResolvedValueOnce({ paired: [{ deviceId: "bridge-device", roles: ["operator"] }] });
      } else {
        request.mockResolvedValueOnce({});
      }
      const connectCalls: McpClientTempState[] = [];
      const connect = vi.fn(async (state: McpClientTempState) => {
        connectCalls.push(state);
        return connectCalls.length === 1 ? firstHandle : secondHandle;
      });

      try {
        await expect(
          connectMcpClientWithPairingReconnect({
            connect,
            maybeApprovePairing: () => maybeApprovePendingBridgePairing({ request }),
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
    },
  );

  it.each([
    { label: "missing device", paired: [] },
    {
      label: "other approval failure",
      message: "approval forbidden",
      paired: [{ deviceId: "bridge-device", roles: ["operator"] }],
    },
    { label: "different device", paired: [{ deviceId: "other-device", roles: ["operator"] }] },
    { label: "wrong role", paired: [{ deviceId: "bridge-device", roles: ["node"] }] },
  ])("preserves stale-approval failure for $label", async ({ paired, message }) => {
    const failure = new Error(message ?? "unknown requestId");
    const request = vi
      .fn<Parameters<typeof maybeApprovePendingBridgePairing>[0]["request"]>()
      .mockResolvedValueOnce({
        pending: [{ requestId: "pair-request", deviceId: "bridge-device", role: "operator" }],
      })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ paired });
    await expect(maybeApprovePendingBridgePairing({ request })).rejects.toBe(failure);
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
