import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import type { Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent } from "../plugin-sdk/agent-core.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { isToolResultError } from "./tool-result-error.js";
import {
  singleToolCallStreamFn,
  toolSearchTestModel as model,
} from "./tool-search-loop.test-support.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function makeMcpRuntime(result: CallToolResult): SessionMcpRuntime {
  const catalog = {
    version: 1 as const,
    generatedAt: 0,
    servers: {
      searchServer: {
        serverName: "searchServer",
        launchSummary: "searchServer",
        toolCount: 1,
        supportsParallelToolCalls: false,
      },
    },
    tools: [
      {
        serverName: "searchServer",
        safeServerName: "searchServer",
        toolName: "query",
        description: "Query the search backend",
        fallbackDescription: "Query the search backend",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
  return {
    sessionId: "session-tool-search-mcp-error",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => result,
    dispose: async () => {},
  };
}

function createDeferredCall(target: AnyAgentTool) {
  const config = { tools: { toolSearch: { enabled: true, mode: "tools" as const } } };
  const catalogRef = createToolSearchCatalogRef();
  const controls = createToolSearchTools({ config, catalogRef });
  applyToolSearchCatalog({ tools: [...controls, target], config, catalogRef });
  return expectDefined(
    controls.find((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME),
    `${TOOL_CALL_RAW_TOOL_NAME} control`,
  );
}

async function createDeferredMcpCall(result: CallToolResult) {
  const materialized = await materializeBundleMcpToolsForRun({ runtime: makeMcpRuntime(result) });
  const target = expectDefined(materialized.tools[0], "materialized MCP tool");
  return { callTool: createDeferredCall(target), target };
}

describe("Tool Search MCP failures", () => {
  it("keeps deferred MCP images model-visible beside their text", async () => {
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const { callTool, target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Saved preview" }, image],
    });

    const result = await callTool.execute("deferred-image", { id: target.name, args: {} });

    expect(result.content).toContainEqual(image);
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("Saved preview");
    expect(text).not.toContain(image.data);
  });

  it.each([
    { innerStatus: "timeout", outerStatus: "timed_out" },
    { innerStatus: "cancelled", outerStatus: "cancelled" },
  ] as const)(
    "preserves a deferred $innerStatus terminal kind",
    async ({ innerStatus, outerStatus }) => {
      const target: AnyAgentTool = {
        name: `native_${innerStatus}`,
        label: `Native ${innerStatus}`,
        description: `Return a resolved ${innerStatus} result`,
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => jsonResult({ status: innerStatus }),
      };
      const callTool = createDeferredCall(target);

      const wrappedResult = await callTool.execute(`deferred-${innerStatus}`, {
        id: target.name,
        args: {},
      });
      expect(wrappedResult.details).toMatchObject({
        result: { details: { status: innerStatus } },
        status: outerStatus,
      });
      expect(isToolResultError(wrappedResult)).toBe(true);
    },
  );

  it("records the outer dispatch_action lifecycle and transcript result as failed", async () => {
    const { callTool, target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Backend request failed" }],
      isError: true,
    });
    const events: AgentEvent[] = [];
    const streamFn = singleToolCallStreamFn({
      id: "deferred-mcp-call",
      name: callTool.name,
      arguments: { id: target.name, args: {} },
    });

    const messages = await runAgentLoop(
      [{ role: "user", content: "query the backend", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [callTool] },
      {
        model,
        convertToLlm: (agentMessages) => agentMessages as Message[],
        // Match the embedded extension's lifecycle/transcript error classification.
        afterToolCall: async ({ result, isError }) => ({
          isError: isError || isToolResultError(result),
        }),
      },
      (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );
    expect(
      events.find(
        (event) =>
          event.type === "tool_execution_end" && event.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, result: { details: { status: "failed" } } });
    expect(
      messages.find(
        (message) => message.role === "toolResult" && message.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, details: { status: "failed" } });
  });
});
