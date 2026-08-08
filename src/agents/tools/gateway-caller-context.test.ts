import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("preserves tool metadata used by policy and presentation layers", () => {
    const tool: AnyAgentTool = {
      name: "plugin_tool",
      label: "Plugin tool",
      description: "plugin tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };
    setPluginToolMeta(tool, { pluginId: "plugin-a", optional: false });
    setChannelAgentToolMeta(tool as never, { channelId: "telegram" });
    setToolTerminalPresentation(tool, () => ({ text: "done" }));

    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = wrapToolWithGatewayCallerIdentity(beforeWrapped, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("scopes nested approval ownership without replacing the native runtime owner", async () => {
    let nestedOwner: string | undefined;
    let restoredOwner: string | undefined;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        approvalOwnerPluginId: "codex",
      },
      async () => {
        await withGatewayToolApprovalOwner("policy-plugin", async () => {
          nestedOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
        });
        restoredOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
      },
    );

    expect(nestedOwner).toBe("policy-plugin");
    expect(restoredOwner).toBe("codex");
  });

  it("preserves admitted host authority through nested built-in tool wrappers", async () => {
    const operationalRunInstance = { instanceId: "instance-1", runId: "run-1" };
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-1");
    let nestedIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance,
        executionIdentityToken,
        turnSourceChannel: "telegram",
      },
      async () => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "nested",
            sessionKey: "agent:nested:session-2",
            cronSelfManagementJobId: "job-1",
            turnSourceChannel: "discord",
          },
          () => {
            nestedIdentity = getGatewayToolCallerIdentity();
          },
        );
      },
    );

    expect(nestedIdentity).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      operationalRunInstance,
      executionIdentityToken,
      cronSelfManagementJobId: "job-1",
      turnSourceChannel: "telegram",
    });
  });
});
