import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { consumeMcpCodeModeGuestResult } from "../agents/mcp-content.js";
import { NodeHostMcpError } from "../node-host/mcp.js";
import {
  createNodeWorkerMcpTurn,
  type NodeWorkerMcpSession,
} from "../node-host/node-worker-mcp.js";
import { createWorkerLocalMcpClient, createWorkerLocalMcpTool } from "./worker-local-mcp.js";
import {
  parseWorkerProcessMessage,
  parseWorkerProcessRequest,
  type WorkerProcessMessage,
} from "./worker-process-protocol.js";
import { createWorkerLaunchDescriptorForTest } from "./worker-process.test-support.js";

const entry: WorkerToolSurface["tools"][number] = {
  id: "generation-1:0",
  execution: "placement",
  definition: {
    name: "documents_search",
    label: "Search",
    description: "Search documents",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  plugin: {
    pluginId: "node-mcp",
    optional: false,
    mcp: {
      node: { id: "node-1" },
      serverName: "documents",
      safeServerName: "documents",
      toolName: "search",
      operation: "tool",
    },
  },
};
const grant = { id: entry.id, server: "documents", tool: "search" };
const grants = [grant];

it("invokes the admitted handle over the supervisor pipe and projects the result for Code Mode in the worker", async () => {
  const result = { content: [{ type: "text", text: "found" }], structuredContent: { document: 7 } };
  const write = vi.fn(async (message: WorkerProcessMessage) => {
    const frame = parseWorkerProcessMessage(structuredClone(message));
    if (frame?.type !== "mcp-call") {
      throw new Error("Unexpected worker frame");
    }
    const reply = parseWorkerProcessRequest({
      type: "mcp-result",
      turnId: frame.turnId,
      requestId: frame.requestId,
      result,
    });
    if (reply.type !== "mcp-result") {
      throw new Error("Unexpected supervisor frame");
    }
    client.receive(reply);
  });
  const client = createWorkerLocalMcpClient("turn-1", write);
  const tool = createWorkerLocalMcpTool(entry, grants, client.call)!;
  const response = await tool.execute("call-1", { query: "hello" });
  expect(write).toHaveBeenCalledExactlyOnceWith({
    type: "mcp-call",
    turnId: "turn-1",
    requestId: expect.any(String),
    toolId: entry.id,
    arguments: { query: "hello" },
  });
  expect(consumeMcpCodeModeGuestResult(response)).toEqual(result);

  await expect(tool.execute("call-2", { query: 42 })).rejects.toThrow("arguments");
  expect(write).toHaveBeenCalledTimes(1);
  expect(
    createWorkerLocalMcpTool(entry, [{ ...grant, tool: "delete" }], client.call),
  ).toBeUndefined();
});

it("delivers bounded, redacted MCP diagnostics to the worker tool and hides unexpected exceptions", async () => {
  const descriptor = createWorkerLaunchDescriptorForTest({
    assignment: { toolAuthority: { allowedToolNames: [entry.definition.name], mcpTools: grants } },
  });
  const callMcpTool = vi.fn<NodeWorkerMcpSession["callMcpTool"]>();
  const turn = createNodeWorkerMcpTurn(descriptor, {
    descriptors: [
      {
        name: entry.definition.name,
        command: "mcp.tools.call.v1",
        description: entry.definition.description,
        parameters: entry.definition.parameters,
        pluginId: "node-mcp",
        mcp: { server: grant.server, tool: grant.tool },
      },
    ],
    callMcpTool,
    signal: new AbortController().signal,
  })!;
  const client = createWorkerLocalMcpClient(descriptor.assignment.turnId, async (frame) => {
    if (frame.type === "mcp-call") {
      await turn.invoke(frame, async (reply) => client.receive(reply));
    }
  });
  const tool = createWorkerLocalMcpTool(entry, grants, client.call)!;
  const run = () => tool.execute("call", { query: "hello" });

  callMcpTool.mockRejectedValueOnce(new NodeHostMcpError("MCP_TOOL_TIMEOUT", "x".repeat(2_000)));
  await expect(run()).rejects.toThrow(new Error("MCP_TOOL_TIMEOUT: " + "x".repeat(1_024)));

  const unauthorized = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "private response", {
    status: 401,
  });
  callMcpTool.mockRejectedValueOnce(
    new NodeHostMcpError("MCP_TOOL_ERROR", unauthorized.message, { cause: unauthorized }),
  );
  await expect(run()).rejects.toThrow(
    new Error(
      "MCP_TOOL_ERROR: authentication refused (401); check this MCP server's credentials or sign in again",
    ),
  );

  callMcpTool.mockRejectedValueOnce(
    new NodeHostMcpError(
      "MCP_TOOL_ERROR",
      "Error POSTing to endpoint (HTTP 500): private response",
    ),
  );
  await expect(run()).rejects.toThrow(
    new Error("MCP_TOOL_ERROR: Error POSTing to endpoint (HTTP 500): [redacted response body]"),
  );

  callMcpTool.mockResolvedValueOnce({ content: [], structuredContent: [42] });
  await expect(run()).rejects.toThrow(/MCP_SDK_RESULT_UNREPRESENTABLE: MCP tools\/call/);

  callMcpTool.mockRejectedValueOnce(
    Object.assign(new Error("private failure details"), { code: "MCP_TOOL_ERROR" }),
  );
  await expect(run()).rejects.toThrow(new Error("Worker MCP call failed"));
});

it("cancels the same local request when a tool call aborts", async () => {
  const write = vi.fn(async (_message: WorkerProcessMessage) => {});
  const client = createWorkerLocalMcpClient("turn-2", write);
  const controller = new AbortController();
  const call = client.call(entry.id, {}, controller.signal);
  const first = write.mock.calls[0]?.[0];
  if (first?.type !== "mcp-call") {
    throw new Error("Expected an MCP call");
  }
  controller.abort(new Error("turn cancelled"));
  await expect(call).rejects.toThrow("turn cancelled");
  expect(write).toHaveBeenLastCalledWith({
    type: "mcp-cancel",
    turnId: "turn-2",
    requestId: first.requestId,
  });
});
