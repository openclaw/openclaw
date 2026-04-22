import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";

const callGatewayTool = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayTool.mockReset();
  resetGlobalHookRunner();
});

describe("handleMcpJsonRpc tools/call", () => {
  it("invokes registered before_tool_call hook and blocks on approval", async () => {
    let hookCalls = 0;
    const execute = vi.fn().mockResolvedValue({ content: "should not dispatch" });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            hookCalls += 1;
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
              },
            };
          },
        },
      ]),
    );
    callGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const result = (await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_store", arguments: { text: "hello" } },
      },
      tools: [tool],
      toolSchema: [],
    })) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };

    expect(hookCalls).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toEqual([expect.objectContaining({ type: "text" })]);
    expect(result.result.content[0].text).toMatch(/approval/i);
  });

  it("dispatches tool.execute normally when no hooks are registered", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = {
      name: "plain_tool",
      description: "Plain tool",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const result = (await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "plain_tool", arguments: {} },
      },
      tools: [tool],
      toolSchema: [],
    })) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.result.isError).toBe(false);
    expect(result.result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("passes through allowed calls when before_tool_call returns no block", async () => {
    let hookCalls = 0;
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "dispatched" }],
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            hookCalls += 1;
            return {}; // no block, no params rewrite
          },
        },
      ]),
    );
    const tool = {
      name: "plain_tool",
      description: "Plain tool",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const result = (await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "plain_tool", arguments: {} },
      },
      tools: [tool],
      toolSchema: [],
    })) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };

    expect(hookCalls).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.result.isError).toBe(false);
    expect(result.result.content).toEqual([{ type: "text", text: "dispatched" }]);
  });
});
