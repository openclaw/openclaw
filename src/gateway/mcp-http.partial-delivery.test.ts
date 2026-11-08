import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { projectMessageActionPartialFailureResult } from "../agents/tools/message-tool-scheduled-execution.js";
import { createChannelPartialDeliveryError } from "../channels/turn/partial-delivery-error.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import {
  buildMockMcpToolSchema,
  makeMessageTool,
  mcpToolCallMessage,
  type McpToolResultPayload,
} from "./mcp-http.test-support.js";

describe("MCP message tool partial delivery", () => {
  it("keeps accepted message ids on the caller-visible error", async () => {
    const details = expectDefined(
      projectMessageActionPartialFailureResult({
        error: createChannelPartialDeliveryError(new Error("second chunk failed"), {
          messageIds: ["100000000000000021"],
          visibleReplySent: true,
        }),
        action: "send",
      }),
      "partial delivery projection",
    );
    const tool = makeMessageTool({
      execute: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      }),
    });

    // SAFETY: the JSON-RPC tools/call result carries the MCP tool result payload.
    const payload = (await handleMcpJsonRpc({
      message: mcpToolCallMessage("message", {
        action: "send",
        target: "chat123",
        message: "sent partly",
      }),
      // SAFETY: the mock factory produces the tool shape mcp-http consumes.
      tools: [tool as unknown as AnyAgentTool],
      toolSchema: buildMockMcpToolSchema([tool]),
    })) as McpToolResultPayload;

    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain("100000000000000021");
  });
});
