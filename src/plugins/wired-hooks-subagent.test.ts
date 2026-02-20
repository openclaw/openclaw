/**
 * Test: subagent_spawned & subagent_ended hook wiring
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("subagent hook runner methods", () => {
  it("runSubagentSpawned invokes registered subagent_spawned hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "subagent_spawned", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSubagentSpawned(
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
          threadId: "456",
        },
        threadRequested: true,
      },
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
    );

    expect(handler).toHaveBeenCalledWith(
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
          threadId: "456",
        },
        threadRequested: true,
      },
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
    );
  });

  it("runSubagentEnded invokes registered subagent_ended hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "subagent_ended", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSubagentEnded(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
        runId: "run-1",
        outcome: "ok",
      },
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
    );

    expect(handler).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
        runId: "run-1",
        outcome: "ok",
      },
      {
        runId: "run-1",
        targetSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
    );
  });

  it("hasHooks returns true for registered subagent hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "subagent_spawned", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("subagent_spawned")).toBe(true);
    expect(runner.hasHooks("subagent_ended")).toBe(false);
  });
});
