import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "../agents/tools/message-tool-execution.test-support.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createChannelPartialDeliveryError } from "../channels/turn/partial-delivery-error.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../infra/outbound/message-action-runner.test-support.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import {
  buildMockMcpToolSchema,
  mcpToolCallMessage,
  type McpToolResultPayload,
} from "./mcp-http.test-support.js";

beforeEach(() => {
  stubMessageSecrets();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("MCP message tool partial delivery", () => {
  it("keeps accepted message ids on the caller-visible error", async () => {
    registerMessageChannel({
      ...workspaceTestPlugin,
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction: async () => {
          throw createChannelPartialDeliveryError(new Error("second attachment failed"), {
            messageIds: ["100000000000000021"],
            visibleReplySent: true,
          });
        },
      },
    } satisfies ChannelPlugin);
    setRuntimeConfigSnapshot(workspaceConfig);
    const tool = createMessageTool({
      config: workspaceConfig,
      runId: "mcp-partial-delivery",
      currentChannelProvider: "workspace",
      currentChannelId: "C12345678",
      currentMessagingTarget: "C12345678",
    });

    // SAFETY: the JSON-RPC tools/call result carries the MCP tool result payload.
    const payload = (await handleMcpJsonRpc({
      message: mcpToolCallMessage("message", {
        action: "send",
        target: "C12345678",
        message: "sent partly",
      }),
      tools: [tool],
      toolSchema: buildMockMcpToolSchema([tool]),
    })) as McpToolResultPayload;

    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain("100000000000000021");
  });
});
