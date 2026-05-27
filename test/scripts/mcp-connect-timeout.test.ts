import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpWithTimeout } from "../../scripts/e2e/mcp-connect-timeout.ts";

describe("MCP stdio connect timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
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
      connect: vi.fn(() => new Promise<void>(() => undefined)),
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
});
