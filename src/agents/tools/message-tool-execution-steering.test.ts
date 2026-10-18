import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyInternalToolExecutionPreparer } from "../../../packages/agent-core/src/internal-hooks.js";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as commandSecretTargets from "../../cli/command-secret-targets.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../../infra/outbound/message-action-runner.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { installMessageToolTerminalHook } from "../embedded-agent-runner/run/message-tool-terminal.js";
import {
  terminalModel,
  terminalResponse,
  terminalToolCall,
} from "../embedded-agent-runner/run/message-tool-terminal.test-support.js";
import { Agent, type AgentTool } from "../runtime/index.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";

beforeEach(() => {
  vi.spyOn(commandSecretTargets, "getScopedChannelsCommandSecretTargets").mockReturnValue({
    targetIds: new Set<string>(),
  });
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

describe("message tool source reply steering", () => {
  it("delivers the completed source reply after a permission refresh replaces the tool", async () => {
    let resolveLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    let resolveLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      resolveLookup = resolve;
    });
    const delivered: string[] = [];
    const handleAction = vi.fn(async ({ params }: ChannelMessageActionContext) => {
      delivered.push(typeof params.message === "string" ? params.message : "");
      return jsonResult({ ok: true, messageId: `message-${delivered.length}`, toJid: params.to });
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            actions: {
              describeMessageTool: () => ({ actions: ["send"] }),
              handleAction,
            },
          } satisfies ChannelPlugin,
        },
      ]),
    );

    const identity = {
      agentId: "main",
      runId: "steered-source-reply",
      sessionKey: "agent:main:workspace:direct:C123",
    };
    const source = {
      currentChannelProvider: "workspace",
      currentChannelId: "C123",
      currentMessagingTarget: "C123",
      currentMessageId: "inbound-a",
    };
    const config: OpenClawConfig = {
      ...workspaceConfig,
      tools: { message: { crossContext: { allowWithinProvider: true } } },
    };
    const capability = mintMessageActionTurnCapability({
      ...identity,
      requesterAccountId: "default",
      toolContext: source,
    });
    const messageTool = createMessageTool({
      config,
      agentSessionKey: identity.sessionKey,
      ...source,
      ...identity,
      agentAccountId: "default",
      messageActionTurnCapability: capability,
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplyOnly: true,
    });
    const lookupTool = {
      label: "Lookup",
      name: "lookup",
      description: "Look up a value while the source reply is pending",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: vi.fn(async () => {
        resolveLookupStarted();
        await lookupGate;
        return jsonResult({ result: "lookup complete" });
      }),
    } satisfies AgentTool;
    const laterTool = {
      label: "Later",
      name: "later",
      description: "Run after the message tool if the turn is not terminated",
      parameters: Type.Object({}),
      execute: vi.fn(async () => jsonResult({ result: "should stay skipped" })),
    } satisfies AgentTool;
    const responses = [
      terminalResponse(
        [
          terminalToolCall("lookup", "lookup-a"),
          terminalToolCall("message", "message-a", {
            action: "send",
            message: "Answer for input A.",
          }),
          terminalToolCall("later", "later-a"),
        ],
        "toolUse",
      ),
      terminalResponse(
        [
          terminalToolCall("message", "message-b", {
            action: "send",
            message: "Answer for input B.",
          }),
        ],
        "toolUse",
      ),
    ];
    const agent = new Agent({
      initialState: { model: terminalModel, tools: [lookupTool, messageTool, laterTool] },
      streamFn: () => {
        const response = responses.shift();
        if (!response) {
          throw new Error("unexpected model request");
        }
        return response;
      },
    });
    setRuntimeConfigSnapshot(config);
    const refreshMessageToolSteeringAllowance = installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      config,
      currentProvider: "workspace",
      currentAccountId: "default",
      currentChannelId: "C123",
      currentMessagingTarget: "C123",
      sessionKey: identity.sessionKey,
    }) as (() => void) | undefined;
    const refreshedMessageTool = copyInternalToolExecutionPreparer(messageTool, {
      ...messageTool,
    });
    agent.state.tools = [lookupTool, refreshedMessageTool, laterTool];
    // The base implementation returns void; leaving its allowance bound to the old tool makes this assertion fail.
    refreshMessageToolSteeringAllowance?.();

    try {
      const run = agent.prompt("input A");
      await lookupStarted;
      agent.steer({ role: "user", content: "input B", timestamp: 2 });
      resolveLookup();
      await run;

      expect(delivered).toEqual(["Answer for input A.", "Answer for input B."]);
      expect(laterTool.execute).not.toHaveBeenCalled();
      expect(agent.state.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "later-a",
            details: { status: "skipped", deniedReason: "steering" },
          }),
        ]),
      );
    } finally {
      resolveLookup();
      revokeMessageActionTurnCapability(capability);
    }
  });
});
