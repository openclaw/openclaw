import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import { createAgentExecutionAttribution } from "../agent-execution-attribution.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS } from "../before-tool-call-metadata.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  captureGatewayToolCallerIdentity,
  createGatewayToolCallerWrapper,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("captures explicit host attribution once and stays unbound without authority", () => {
    expect(
      captureGatewayToolCallerIdentity("agent-a", {
        agentSessionKey: " agent-a:session ",
      }),
    ).toEqual({
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    const attribution = createAgentExecutionAttribution({
      runId: "run-a",
      lifecycleGeneration: "generation-a",
      sessionKey: "agent-a:session",
      agentId: "agent-a",
    });
    const captured = captureGatewayToolCallerIdentity(
      "agent-a",
      { agentSessionKey: "agent-a:session" },
      { attribution, executionIdentityEnabled: true },
    );

    expect(captured).toEqual({
      agentId: "agent-a",
      sessionKey: "agent-a:session",
      executionIdentity: {
        tokenVersion: 1,
        runId: attribution.runId,
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        createdAt: attribution.createdAt,
      },
    });
    expect(
      captureGatewayToolCallerIdentity(
        "agent-a",
        { agentSessionKey: "agent-a:session" },
        { attribution, executionIdentityEnabled: false },
      ),
    ).toEqual({ agentId: "agent-a", sessionKey: "agent-a:session" });
    expect(captureGatewayToolCallerIdentity("agent-a", undefined)).toBeUndefined();
  });

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
    const wrapped = createGatewayToolCallerWrapper("agent-a", {
      agentSessionKey: "agent-a:session",
    })(beforeWrapped);

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("preserves before-tool diagnostic controls through final caller wrapping", async () => {
    const tool: AnyAgentTool = {
      name: "diagnostic_tool",
      label: "Diagnostic tool",
      description: "diagnostic tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };
    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = createGatewayToolCallerWrapper("agent-a", {
      agentSessionKey: "agent-a:session",
    })(beforeWrapped);
    const taggedBefore = beforeWrapped as unknown as Record<symbol, unknown>;
    const taggedWrapped = wrapped as unknown as Record<symbol, unknown>;
    expect(taggedWrapped[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS]).toBe(
      taggedBefore[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS],
    );

    const emittedTypes: string[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("tool.execution.")) {
        emittedTypes.push(event.type);
      }
    });
    try {
      setBeforeToolCallDiagnosticsEnabled(wrapped, false);
      await wrapped.execute?.("diagnostics-disabled", {});
      await waitForDiagnosticEventsDrained();
      expect(emittedTypes).toEqual([]);

      setBeforeToolCallDiagnosticsEnabled(wrapped, true);
      await wrapped.execute?.("diagnostics-enabled", {});
      await waitForDiagnosticEventsDrained();
      expect(emittedTypes).toEqual(["tool.execution.started", "tool.execution.completed"]);
    } finally {
      stop();
    }
  });
});
