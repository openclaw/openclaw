import { afterEach, expect, it } from "vitest";
import {
  createEmbeddedRunHandle as createHandle,
  registerTestEmbeddedRun,
  testing as embeddedTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import type { ReplyBackendMessageInjectionV2 as Injection } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget as beginInjection,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createTestReplyOperation as createOperation } from "./reply-run-registry.test-helpers.js";

afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetSessionControllerForTest();
});

async function steerAndObserve(runId: string, inputRequesterDeviceId?: string) {
  const sessionId = `session-${runId}`;
  const sessionKey = `agent:main:${runId}`;
  const operation = createOperation({ sessionId, sessionKey });
  await operation.bindToolAuthoritySnapshotAsync({
    fingerprint: () => "authority",
    project: () => "authority",
    projectAsync: async () => "authority",
  });
  await operation.bindToolAuthorityRouteAsync({ provider: "test", model: "test" });
  const sink: Injection = {
    version: 2,
    isAvailable: () => true,
    queueMessage: async (_text, options) => {
      options?.onQueueAccepted?.(true);
    },
  };
  registerTestEmbeddedRun(
    sessionId,
    {
      ...createHandle({ runId, toolAuthorityFingerprint: "authority" }),
      kind: "embedded" as const,
      cancel() {},
      messageInjectionV2: sink,
    },
    sessionKey,
    undefined,
    undefined,
    operation,
  );
  operation.setPhase("running");
  const attempt = await beginInjection(
    captureReplyMessageInjectionTarget(operation)!,
    "also do X",
    {
      isInboundUserMessage: true,
      toolAuthorityOverlay: { senderIsOwner: false, disableTools: false, traceAuthorized: false },
      ...(inputRequesterDeviceId ? { inputRequesterDeviceId } : {}),
    },
  );
  await expect(attempt.outcome).resolves.toMatchObject({ status: "accepted" });

  const seen: { tool?: string; agent?: string }[] = [];
  const runner = createHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: (...args: unknown[]) => {
          const ctx = args[1] as { requester?: { deviceId?: string } };
          seen.push({ tool: ctx.requester?.deviceId });
        },
      },
      {
        hookName: "agent_end",
        handler: (...args: unknown[]) => {
          const ctx = args[1] as { requesterDeviceId?: string };
          seen.push({ agent: ctx.requesterDeviceId });
        },
      },
    ]),
    { catchErrors: false },
  );
  await runner.runBeforeToolCall(
    { toolName: "read", params: {} },
    { toolName: "read", runId, requester: { senderId: "openclaw-ios", deviceId: "device-a" } },
  );
  await runner.runAgentEnd(
    { messages: [], success: true },
    { runId, sessionKey, requesterDeviceId: "device-a" },
  );
  return seen;
}

it("withholds the run's device from hooks after another device steers into it", async () => {
  await expect(steerAndObserve("run-steered-by-b", "device-b")).resolves.toEqual([
    { tool: undefined },
    { agent: undefined },
  ]);
  // A device-less source is not the run's device either.
  await expect(steerAndObserve("run-steered-by-cli")).resolves.toEqual([
    { tool: undefined },
    { agent: undefined },
  ]);
});

it("keeps the device when the same device steers its own run", async () => {
  await expect(steerAndObserve("run-steered-by-a", "device-a")).resolves.toEqual([
    { tool: "device-a" },
    { agent: "device-a" },
  ]);
});
