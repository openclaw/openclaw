import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

describe("subagent hook runner methods", () => {
  const baseRequester = {
    channel: "discord",
    accountId: "work",
    to: "channel:123",
    threadId: "456",
  };

  const baseSubagentCtx = {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
  };

  const deliveryEvent = {
    childSessionKey: baseSubagentCtx.childSessionKey,
    requesterSessionKey: baseSubagentCtx.requesterSessionKey,
    requesterOrigin: baseRequester,
    childRunId: baseSubagentCtx.runId,
    spawnMode: "session" as const,
    expectsCompletionMessage: true,
  };
  const target = { origin: { ...baseRequester, to: "channel:777", threadId: "777" } };

  it.each([
    {
      name: "runSubagentSpawned invokes registered subagent_spawned hooks",
      hookName: "subagent_spawned" as const,
      event: {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        mode: "run" as const,
        requester: baseRequester,
        threadRequested: true,
      },
    },
    {
      name: "runSubagentProgress invokes registered subagent_progress hooks",
      hookName: "subagent_progress" as const,
      event: {
        phase: "started" as const,
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        requester: { ...baseRequester, messageId: "message-1" },
      },
    },
    {
      name: "runSubagentDeliveryTarget invokes registered subagent_delivery_target hooks",
      hookName: "subagent_delivery_target" as const,
      event: deliveryEvent,
    },
    {
      name: "runSubagentEnded invokes registered subagent_ended hooks",
      hookName: "subagent_ended" as const,
      event: {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent" as const,
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
        runId: "run-1",
        outcome: "ok" as const,
      },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    const handler = vi.fn(async () => target);
    const { runner } = createHookRunnerWithRegistry([{ hookName, handler }]);
    const result =
      hookName === "subagent_spawned"
        ? await runner.runSubagentSpawned(event, baseSubagentCtx)
        : hookName === "subagent_progress"
          ? await runner.runSubagentProgress(event, baseSubagentCtx)
          : hookName === "subagent_delivery_target"
            ? await runner.runSubagentDeliveryTarget(event, baseSubagentCtx)
            : await runner.runSubagentEnded(event, baseSubagentCtx);
    expect(handler).toHaveBeenCalledWith(event, baseSubagentCtx);
    expect(result).toEqual(hookName === "subagent_delivery_target" ? target : undefined);
  });

  it("runSubagentDeliveryTarget returns undefined when no matching hooks are registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    const result = await runner.runSubagentDeliveryTarget(deliveryEvent, baseSubagentCtx);
    expect(result).toBeUndefined();
  });
});
