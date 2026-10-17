import { describe, expect, it } from "vitest";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";

function initializeResult(serverInstructions?: string) {
  return handleMcpJsonRpc({
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    },
    tools: [],
    toolSchema: [],
    ...(serverInstructions ? { serverInstructions } : {}),
  }) as Promise<{
    result: {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
      instructions?: string;
    };
  }>;
}

describe("mcp loopback initialize", () => {
  it("carries aggregated upstream server instructions when present", async () => {
    const response = await initializeResult("[legal]\nCite authority levels.");
    expect(response.result.instructions).toBe("[legal]\nCite authority levels.");
    expect(response.result.serverInfo.name).toBeTruthy();
  });

  it("omits the instructions field when no upstream server contributes", async () => {
    const response = await initializeResult();
    expect(response.result.instructions).toBeUndefined();
    expect("instructions" in response.result).toBe(false);
  });
});
