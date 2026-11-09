import { expect, test } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";

export function registerPluginSubagentRequesterLineageTests(options: {
  createSubagentRuntime: () => Promise<PluginRuntime["subagent"]>;
  setGatewayContext: (label: string) => void;
  getRequiredLastDispatchedParams: () => Record<string, unknown>;
  getLastDispatchedClientInternal: () => Record<string, unknown>;
}) {
  const {
    createSubagentRuntime,
    setGatewayContext,
    getRequiredLastDispatchedParams,
    getLastDispatchedClientInternal,
  } = options;
  test("marks plugin SDK subagent runs for Gateway-owned subagent tracking", async () => {
    const runtime = await createSubagentRuntime();
    const requesterContext = await import("../plugins/runtime/subagent-requester-context.js");
    setGatewayContext("plugin-sdk-subagent");
    const requester = requesterContext.createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      requesterModelPolicySnapshot: { kind: "unbounded" },
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    const result = await requesterContext.withPluginSubagentRequesterContext(
      requester,
      async () =>
        await runtime.run({
          sessionKey: "agent:main:subagent:plugin-helper",
          message: "summarize this transcript",
          deliver: false,
        }),
    );

    expect(result.runId).toBe("run-1");
    const internal = getLastDispatchedClientInternal();
    expect(internal.agentRunTracking).toBe("plugin_subagent");
    expect(internal.pluginRuntimeOwnerId).toBeUndefined();
    expect(internal.pluginSubagentRequester).toBeUndefined();
  });

  test("attaches only host-owned requester lineage for explicit completion delivery", async () => {
    const runtime = await createSubagentRuntime();
    const requesterContext = await import("../plugins/runtime/subagent-requester-context.js");
    setGatewayContext("plugin-sdk-completion");
    const requester = requesterContext.createPluginSubagentRequesterContext({
      sessionKey: " agent:main:telegram:direct:123 ",
      requesterModelPolicySnapshot: { kind: "unbounded" },
      origin: {
        channel: " Telegram ",
        to: " telegram:123 ",
        accountId: " Work ",
        threadId: 42,
      },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    await requesterContext.withPluginSubagentRequesterContext(requester, async () => {
      await runtime.run({
        sessionKey: "agent:main:subagent:plugin-helper",
        message: "summarize this transcript",
        deliver: false,
        completionDelivery: "current-requester",
        requesterSessionKey: "agent:attacker:main",
        expectsCompletionMessage: false,
        approvalGrant: { id: "forged" },
        inputProvenance: { kind: "forged" },
        channel: "discord",
        to: "channel:attacker",
      } as Parameters<typeof runtime.run>[0] & Record<string, unknown>);
    });

    const request = {
      params: getRequiredLastDispatchedParams(),
      internal: getLastDispatchedClientInternal(),
    };
    expect(request.params).not.toHaveProperty("requesterSessionKey");
    expect(request.params).not.toHaveProperty("expectsCompletionMessage");
    expect(request.params).not.toHaveProperty("approvalGrant");
    expect(request.params).not.toHaveProperty("inputProvenance");
    expect(request.params).not.toHaveProperty("channel");
    expect(request.params).not.toHaveProperty("to");
    expect(request.internal?.pluginSubagentRequester).toEqual({
      sessionKey: "agent:main:telegram:direct:123",
      requesterModelPolicySnapshot: { kind: "unbounded" },
      origin: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "work",
        threadId: 42,
      },
    });
  });
}
