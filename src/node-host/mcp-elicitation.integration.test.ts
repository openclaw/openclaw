import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { startMcpHttpFixture } from "../agents/agent-bundle-mcp-lifecycle.test-support.js";
import { NODE_MCP_ELICITATION_CAPABILITY } from "../infra/node-commands.js";
import type { NodeHostClient } from "./client.js";
import { startNodeHostMcpManager } from "./mcp.js";

it("rejects ambiguous MCP prompts and cancels a pending question when its turn ends", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  const held = createDeferred();
  const release = createDeferred();
  server.registerTool("hold", {}, async () => {
    held.resolve();
    await release.promise;
    return { content: [] };
  });
  server.registerTool("ask", {}, async ({ mcpReq }) => {
    const answer = await mcpReq.elicitInput({
      message: "Which team?",
      requestedSchema: { type: "object", properties: { team: { type: "string" } } },
    });
    return { content: [], structuredContent: answer };
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const http = await startMcpHttpFixture((req, res) => transport.handleRequest(req, res));
  const request = vi
    .fn<(...args: Parameters<NodeHostClient["request"]>) => Promise<never>>()
    .mockRejectedValue(new Error("No answer"));
  const manager = await startNodeHostMcpManager(
    { docs: { url: http.url, transport: "streamable-http" } },
    {
      elicitationClient: {
        serverCapabilities: new Set([NODE_MCP_ELICITATION_CAPABILITY]),
        request,
      },
    },
  );
  try {
    const tool = { server: "docs", tool: "ask", elicitationId: "admitted-tool-id" };
    // An unbound call also occupies this client. Its prompt cannot be safely
    // attributed to a concurrent tool carrying a grant.
    const unbound = manager.callMcpTool({ server: "docs", tool: "hold" });
    await awaitGateBeforeSettlement(
      held.promise,
      unbound,
      "The server never received the tool call",
    );
    const overlap = await manager.callMcpTool(tool);
    expect(overlap).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("unambiguous active requester") }],
    });
    expect(request).not.toHaveBeenCalled();
    release.resolve();
    await unbound;

    const entered = createDeferred();
    request.mockImplementationOnce(async (_method, _payload, options) => {
      entered.resolve();
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const pending = manager.callMcpTool({ ...tool, signal: controller.signal });
    await awaitGateBeforeSettlement(entered.promise, pending, "The server never asked for input");
    controller.abort(new Error("turn ended"));
    await expect(pending).rejects.toThrow("turn ended");
    const prompt = expectDefined(request.mock.calls[0], "missing MCP prompt")[1] as {
      payload: { requestId: string };
    };
    expect(request).toHaveBeenLastCalledWith("node.event", {
      event: "mcp.elicitation",
      payload: { id: tool.elicitationId, requestId: prompt.payload.requestId, cancel: true },
    });
  } finally {
    release.resolve();
    await manager.close();
    await server.close();
    await http.close();
  }
});
