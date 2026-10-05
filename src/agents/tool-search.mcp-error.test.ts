import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent, type AgentMessage } from "../plugin-sdk/agent-core.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { isToolResultError } from "./tool-result-error.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const testUsage = createZeroUsageFixture();

function makeMcpRuntime(result: CallToolResult): SessionMcpRuntime {
  const tool = {
    serverName: "searchServer",
    safeServerName: "searchServer",
    toolName: "query",
    description: "Query the search backend",
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: "Query the search backend",
  };
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
    tools: [tool],
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
  const materialized = await materializeBundleMcpToolsForRun({
    runtime: makeMcpRuntime(result),
  });
  const target = expectDefined(materialized.tools[0], "materialized MCP tool");
  return { callTool: createDeferredCall(target), target };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: testUsage,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

describe("Tool Search MCP failures", () => {
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

  it("records the outer tool_call lifecycle and transcript result as failed", async () => {
    const { callTool, target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Backend request failed" }],
      isError: true,
    });
    const events: AgentEvent[] = [];
    let turn = 0;
    const streamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? assistantMessage([
                {
                  type: "toolCall",
                  id: "deferred-mcp-call",
                  name: callTool.name,
                  arguments: { id: target.name, args: {} },
                },
              ])
            : assistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "query the backend", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [callTool] },
      {
        model,
        convertToLlm: (agentMessages) => agentMessages as Message[],
        // Mirror the embedded extension's production classification rule here
        // to isolate agent-core lifecycle and transcript propagation.
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
        (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          event.type === "tool_execution_end" && event.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, result: { details: { status: "failed" } } });
    expect(
      messages.find(
        (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
          message.role === "toolResult" && message.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, details: { status: "failed" } });
  });
});
