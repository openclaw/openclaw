/**
 * Turn-source approval round-trip tests for gateway tool invocation.
 * Proves the channel binding passed to invokeGatewayTool reaches the
 * plugin.approval.request payload verbatim, and that the native approval
 * route coordinator resolves the same origin target from that payload
 * instead of guessing one when the binding is absent.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearApprovalNativeRouteStateForTest,
  createApprovalNativeRouteReporter,
} from "../infra/approval-native-route-coordinator.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { invokeGatewayTool } from "./tools-invoke-shared.js";

// Approval transport stub: the gateway RPC boundary is the only mocked seam in
// the invoke -> before_tool_call -> approval-request chain under test.
vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

// Perf: the real tool factory instantiates many tools per invoke; this suite
// only needs one plugin-owned tool that the trusted policy gates on approval.
vi.mock("../agents/openclaw-tools.js", async () => {
  const { Type } = await import("typebox");
  const { setPluginToolMeta } = await import("../plugins/tools.js");
  const tool: AnyAgentTool = {
    name: "demo_plugin_tool",
    label: "Demo Plugin Tool",
    description: "Demo plugin tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
  setPluginToolMeta(tool, { pluginId: "demo-plugin", optional: false });
  return { createOpenClawTools: () => [tool] };
});

// Perf: avoid loading the full agent-tools barrel for the loop-detection knob.
vi.mock("../agents/agent-tools.js", () => ({
  resolveToolLoopDetectionConfig: () => ({}),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const cfg: OpenClawConfig = {};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function capturedApprovalRequestPayload(): Record<string, unknown> {
  const call = mockCallGatewayTool.mock.calls.find(
    ([method]) => method === "plugin.approval.request",
  );
  if (!call) {
    throw new Error("expected a plugin.approval.request gateway call");
  }
  return requireRecord(call[2], "plugin.approval.request payload");
}

// Mirrors the gateway-side `plugin.approval.request` payload mapping in
// src/gateway/server-methods/plugin-approval.ts: turn-source fields reach the
// stored PluginApprovalRequestPayload trim-normalized, so feeding the captured
// RPC params through this shape reproduces what the route coordinator sees.
function toPluginApprovalRecord(raw: Record<string, unknown>, id: string): PluginApprovalRequest {
  const trimmedOrNull = (value: unknown): string | null => normalizeOptionalString(value) ?? null;
  const threadId = raw.turnSourceThreadId;
  const nowMs = Date.now();
  return {
    id,
    request: {
      title: requireString(raw.title, "approval title"),
      description: requireString(raw.description, "approval description"),
      toolName: trimmedOrNull(raw.toolName),
      turnSourceChannel: trimmedOrNull(raw.turnSourceChannel),
      turnSourceTo: trimmedOrNull(raw.turnSourceTo),
      turnSourceAccountId: trimmedOrNull(raw.turnSourceAccountId),
      turnSourceThreadId:
        typeof threadId === "string" || typeof threadId === "number" ? threadId : null,
    },
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
  };
}

function createReporterGatewayMock() {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })) as unknown as (<T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>) &
    ReturnType<typeof vi.fn>;
}

// Approver-DM-only delivery with no plan-side origin target: the only origin
// the coordinator can address is the request's turn-source binding.
const approverDmTarget = {
  surface: "approver-dm",
  target: { to: "user:approver" },
  reason: "preferred",
} as const;

async function reportApproverDmDelivery(record: PluginApprovalRequest) {
  const requestGateway = createReporterGatewayMock();
  const reporter = createApprovalNativeRouteReporter({
    handledKinds: new Set(["plugin"]),
    channel: "telegram",
    channelLabel: "Telegram",
    accountId: "acct-1",
    requestGateway,
  });
  reporter.start();
  reporter.observeRequest({ approvalKind: "plugin", request: record });
  await reporter.reportDelivery({
    approvalKind: "plugin",
    request: record,
    deliveryPlan: { targets: [approverDmTarget], originTarget: null, notifyOriginWhenDmOnly: true },
    deliveredTargets: [approverDmTarget],
  });
  return requestGateway;
}

async function invokeDemoTool(params: {
  sessionKey: string;
  turnSource?: {
    messageChannel: string;
    agentTo: string;
    accountId: string;
    agentThreadId: string;
  };
}) {
  return await invokeGatewayTool({
    cfg,
    input: { tool: "demo_plugin_tool", args: {}, sessionKey: params.sessionKey },
    senderIsOwner: true,
    toolCallIdPrefix: "turn-source-test",
    ...params.turnSource,
  });
}

describe("invokeGatewayTool — plugin approval turn-source round trip", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "demo-plugin",
        pluginName: "Demo Plugin",
        source: "test",
        policy: {
          id: "demo-approval-policy",
          description: "Requires approval for the demo plugin tool",
          evaluate: () => ({
            requireApproval: {
              pluginId: "demo-plugin",
              title: "Demo approval",
              description: "Demo plugin tool requires approval",
            },
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearApprovalNativeRouteStateForTest();
  });

  it("forwards the turn-source binding into the approval payload and back to the origin target", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-rt-1",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const outcome = await invokeDemoTool({
      sessionKey: "agent:main:turn-source-rt",
      turnSource: {
        messageChannel: "telegram",
        agentTo: "tg:12345",
        accountId: "acct-1",
        agentThreadId: "77",
      },
    });

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      toolName: "demo_plugin_tool",
      source: "plugin",
      result: { content: [{ type: "text", text: "ok" }], details: {} },
    });

    const payload = capturedApprovalRequestPayload();
    expect(payload.toolName).toBe("demo_plugin_tool");
    expect(payload.turnSourceChannel).toBe("telegram");
    expect(payload.turnSourceTo).toBe("tg:12345");
    expect(payload.turnSourceAccountId).toBe("acct-1");
    expect(payload.turnSourceThreadId).toBe("77");

    const record = toPluginApprovalRecord(payload, "approval-rt-1");
    const requestGateway = await reportApproverDmDelivery(record);

    expect(requestGateway).toHaveBeenCalledTimes(1);
    const sendCall = requestGateway.mock.calls[0];
    if (!sendCall) {
      throw new Error("expected origin route notice send call");
    }
    expect(sendCall[0]).toBe("send");
    expect(sendCall[1]).toMatchObject({
      channel: "telegram",
      to: "tg:12345",
      accountId: "acct-1",
      threadId: "77",
      idempotencyKey: "approval-route-notice:approval-rt-1",
    });
  });

  it("fails closed on no-route and resolves no origin target without a turn-source binding", async () => {
    // Gateway reports decision:null (no approval route); the runtime must
    // block rather than honor any plugin-supplied allow fallback.
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-neg-1", decision: null });

    const outcome = await invokeDemoTool({ sessionKey: "agent:main:turn-source-missing" });

    expect(outcome).toEqual({
      ok: false,
      status: 403,
      toolName: "demo_plugin_tool",
      error: {
        type: "tool_call_blocked",
        message: "Plugin approval unavailable (no approval route)",
        requiresApproval: true,
      },
    });

    const payload = capturedApprovalRequestPayload();
    expect(payload.turnSourceChannel).toBeUndefined();
    expect(payload.turnSourceTo).toBeUndefined();
    expect(payload.turnSourceAccountId).toBeUndefined();
    expect(payload.turnSourceThreadId).toBeUndefined();

    const record = toPluginApprovalRecord(payload, "approval-neg-1");
    const requestGateway = await reportApproverDmDelivery(record);

    // No turn-source binding and no plan-side origin target: the coordinator
    // must stay silent instead of guessing a chat to notify.
    expect(requestGateway).not.toHaveBeenCalled();
  });
});
