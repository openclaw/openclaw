import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lastTransport: null as { onclose?: (() => void) | undefined } | null,
  serverClose: vi.fn(async () => {}),
  bridgeClose: vi.fn(async () => {
    throw new Error("close boom");
  }),
}));

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class MockStdioServerTransport {
    onclose?: () => void;

    constructor() {
      state.lastTransport = this;
    }
  },
}));

vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class MockMcpServer {
    registerTool() {}

    server = { setNotificationHandler: vi.fn() };
    async connect() {}
    close = state.serverClose;
  },
}));

// mock-isolation: Shutdown fixtures use empty config without starting a real config owner.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

// mock-isolation: Inject a bridge-close failure without starting a real Gateway bridge.
vi.mock("./channel-bridge.js", () => ({
  OpenClawChannelBridge: class MockOpenClawChannelBridge {
    setServer() {}
    async start() {}
    close = state.bridgeClose;
    async handleClaudePermissionRequest() {}
  },
}));

describe("serveOpenClawChannelMcp shutdown", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
    state.lastTransport = null;
    state.serverClose.mockClear();
    state.bridgeClose.mockClear();
  });

  it.each([false, true])(
    "closes every owner without unhandled rejections (aggregate=%s)",
    async (aggregate) => {
      if (aggregate) {
        state.serverClose.mockRejectedValueOnce(new Error("server close boom"));
      }
      process.on("unhandledRejection", onUnhandledRejection);
      const { serveOpenClawChannelMcp } = await import("./channel-server.js");
      const servePromise = serveOpenClawChannelMcp({ verbose: false });
      const transport = await vi.waitFor(() => {
        if (!state.lastTransport) {
          throw new Error("MCP stdio transport was not created");
        }
        return state.lastTransport;
      });
      transport.onclose?.();
      if (aggregate) {
        const error = await servePromise.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          expect.objectContaining({ message: "close boom" }),
          expect.objectContaining({ message: "server close boom" }),
        ]);
      } else {
        await expect(servePromise).rejects.toThrow("close boom");
      }
      await setImmediate();
      expect(unhandledRejections).toStrictEqual([]);
      expect(state.bridgeClose).toHaveBeenCalledTimes(1);
      expect(state.serverClose).toHaveBeenCalledTimes(1);
    },
  );
});
