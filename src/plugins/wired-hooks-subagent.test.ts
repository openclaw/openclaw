/**
 * Test: subagent_spawning, subagent_delivery_target, subagent_spawned & subagent_ended hook wiring
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

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

  it.each([
    {
      name: "runSubagentSpawning invokes registered subagent_spawning hooks",
      hookName: "subagent_spawning" as const,
      methodName: "runSubagentSpawning" as const,
      event: {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        mode: "session" as const,
        requester: baseRequester,
        threadRequested: true,
      },
      ctx: {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
      handlerResult: { status: "ok", threadBindingReady: true as const },
      expectedResult: { status: "ok", threadBindingReady: true },
    },
    {
      name: "runSubagentSpawned invokes registered subagent_spawned hooks",
      hookName: "subagent_spawned" as const,
      methodName: "runSubagentSpawned" as const,
      event: {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        mode: "run" as const,
        requester: baseRequester,
        threadRequested: true,
      },
      ctx: baseSubagentCtx,
    },
    {
      name: "runSubagentDeliveryTarget invokes registered subagent_delivery_target hooks",
      hookName: "subagent_delivery_target" as const,
      methodName: "runSubagentDeliveryTarget" as const,
      event: {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: baseRequester,
        childRunId: "run-1",
        spawnMode: "session" as const,
        expectsCompletionMessage: true,
      },
      ctx: baseSubagentCtx,
      handlerResult: {
        origin: {
          channel: "discord" as const,
          accountId: "work",
          to: "channel:777",
          threadId: "777",
        },
      },
      expectedResult: {
        origin: {
          channel: "discord",
          accountId: "work",
          to: "channel:777",
          threadId: "777",
        },
      },
    },
    {
      name: "runSubagentEnded invokes registered subagent_ended hooks",
      hookName: "subagent_ended" as const,
      methodName: "runSubagentEnded" as const,
      event: {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent" as const,
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
        runId: "run-1",
        outcome: "ok" as const,
      },
      ctx: baseSubagentCtx,
    },
  ] as const)(
    "$name",
    async ({ hookName, methodName, event, ctx, handlerResult, expectedResult }) => {
      const handler = vi.fn(async () => ({ status: "ok", threadBindingReady: true as const }));
      if (handlerResult !== undefined) {
        handler.mockResolvedValue(handlerResult as never);
      }
      const registry = createMockPluginRegistry([{ hookName, handler }]);
      const runner = createHookRunner(registry);
      const result =
        methodName === "runSubagentSpawning"
          ? await runner.runSubagentSpawning(event, ctx)
          : methodName === "runSubagentSpawned"
            ? await runner.runSubagentSpawned(event, ctx)
            : methodName === "runSubagentDeliveryTarget"
              ? await runner.runSubagentDeliveryTarget(event, ctx)
              : await runner.runSubagentEnded(event, ctx);

      expect(handler).toHaveBeenCalledWith(event, ctx);
      if (expectedResult !== undefined) {
        expect(result).toEqual(expectedResult);
        return;
      }
      expect(result).toBeUndefined();
    },
  );

  it("runSubagentDeliveryTarget returns undefined when no matching hooks are registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);
    const result = await runner.runSubagentDeliveryTarget(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: baseRequester,
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      baseSubagentCtx,
    );
    expect(result).toBeUndefined();
  });

  it("hasHooks returns true for registered subagent hooks", () => {
    const registry = createMockPluginRegistry([
      { hookName: "subagent_spawning", handler: vi.fn() },
      { hookName: "subagent_delivery_target", handler: vi.fn() },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(true);
    expect(runner.hasHooks("subagent_spawned")).toBe(false);
    expect(runner.hasHooks("subagent_ended")).toBe(false);
  });
});
