/** Tests before-tool-call hook ordering, mutation, and cancellation behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToolExecutionErrorKind } from "../agents/tool-result-error.js";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookToolContext } from "./types.js";
import type { PluginHookBeforeToolCallResult } from "./types.js";

const stubCtx: PluginHookToolContext = {
  toolName: "bash",
  agentId: "main",
  sessionKey: "agent:main:main",
};

async function runBeforeToolCallWithHooks(
  registry: PluginRegistry,
  hooks: ReadonlyArray<{
    pluginId: string;
    result: PluginHookBeforeToolCallResult;
    priority?: number;
  }>,
) {
  addStaticTestHooks(registry, {
    hookName: "before_tool_call",
    hooks,
  });
  const runner = createHookRunner(registry);
  return await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
}

function expectRequireApprovalResult(
  result: PluginHookBeforeToolCallResult | undefined,
  expected: {
    block?: boolean;
    blockReason?: string;
    params?: Record<string, unknown>;
    requireApproval?: PluginHookBeforeToolCallResult["requireApproval"];
  },
) {
  expect(result?.block).toBe(expected.block);
  expect(result?.blockReason).toBe(expected.blockReason);
  expect(result?.params).toEqual(expected.params);
  expect(result?.requireApproval).toEqual(expected.requireApproval);
}

describe("before_tool_call hook merger — requireApproval", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      name: "propagates requireApproval from a single plugin",
      hooks: [
        {
          pluginId: "sage",
          result: {
            requireApproval: {
              id: "approval-1",
              title: "Sensitive tool",
              description: "This tool does something sensitive",
              severity: "warning",
            },
          },
        },
      ],
      expectedApproval: {
        id: "approval-1",
        title: "Sensitive tool",
        description: "This tool does something sensitive",
        severity: "warning",
        pluginId: "sage",
      },
    },
    {
      name: "stamps pluginId from the registration",
      hooks: [
        {
          pluginId: "my-plugin",
          result: {
            requireApproval: {
              id: "a1",
              title: "T",
              description: "D",
            },
          },
        },
      ],
      expectedApproval: {
        id: "a1",
        title: "T",
        description: "D",
        pluginId: "my-plugin",
      },
    },
    {
      name: "first hook with requireApproval wins when multiple plugins set it",
      hooks: [
        {
          pluginId: "plugin-a",
          result: {
            requireApproval: {
              title: "First",
              description: "First plugin",
            },
          },
          priority: 100,
        },
        {
          pluginId: "plugin-b",
          result: {
            requireApproval: {
              title: "Second",
              description: "Second plugin",
            },
          },
          priority: 50,
        },
      ],
      expectedApproval: {
        title: "First",
        description: "First plugin",
        pluginId: "plugin-a",
      },
    },
    {
      name: "does not overwrite pluginId if plugin sets it (stamped by merger)",
      hooks: [
        {
          pluginId: "actual-plugin",
          result: {
            requireApproval: {
              title: "T",
              description: "D",
              pluginId: "should-be-overwritten",
            },
          },
        },
      ],
      expectedApproval: {
        title: "T",
        description: "D",
        pluginId: "actual-plugin",
      },
    },
  ] as const)("$name", async ({ hooks, expectedApproval }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, { requireApproval: expectedApproval });
  });

  it("merges block and requireApproval from different plugins", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        pluginId: "approver",
        result: {
          requireApproval: {
            title: "Needs approval",
            description: "Approval needed",
          },
        },
        priority: 100,
      },
      {
        pluginId: "blocker",
        result: {
          block: true,
          blockReason: "blocked",
        },
        priority: 50,
      },
    ]);
    expect(result?.block).toBe(true);
    expect(result?.requireApproval?.title).toBe("Needs approval");
  });

  it("returns undefined requireApproval when no plugin sets it", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      { pluginId: "plain", result: { params: { extra: true } } },
    ]);
    expect(result?.requireApproval).toBeUndefined();
  });

  it.each([
    {
      name: "freezes params after requireApproval when a lower-priority plugin tries to override them",
      hooks: [
        {
          pluginId: "approver",
          result: {
            params: { source: "approver", safe: true },
            requireApproval: {
              title: "Needs approval",
              description: "Approval needed",
            },
          },
          priority: 100,
        },
        {
          pluginId: "mutator",
          result: {
            params: { source: "mutator", safe: false },
          },
          priority: 50,
        },
      ],
      expected: {
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
          pluginId: "approver",
        },
        params: { source: "approver", safe: true },
      },
    },
    {
      name: "still allows block=true from a lower-priority plugin after requireApproval",
      hooks: [
        {
          pluginId: "approver",
          result: {
            params: { source: "approver", safe: true },
            requireApproval: {
              title: "Needs approval",
              description: "Approval needed",
            },
          },
          priority: 100,
        },
        {
          pluginId: "blocker",
          result: {
            block: true,
            blockReason: "blocked",
            params: { source: "blocker", safe: false },
          },
          priority: 50,
        },
      ],
      expected: {
        block: true,
        blockReason: "blocked",
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
          pluginId: "approver",
        },
        params: { source: "approver", safe: true },
      },
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, expected);
  });
});

describe("before_tool_call hook runner — timeout", () => {
  it("times out a hung handler and, being fail-closed, rejects so the tool call is denied", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise(() => {}));
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler }]),
        // Matches the global runner (hook-runner-global.ts): before_tool_call is
        // fail-closed, so a timed-out handler throws instead of silently allowing.
        { logger, failurePolicyByHook: { before_tool_call: "fail-closed" } },
      );

      const run = runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
      const rejection = expect(run).rejects.toThrow(
        "before_tool_call handler from test-plugin failed: timed out after 15000ms",
      );

      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout identity so the tool result reports timed_out, not failed", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise(() => {}));
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler }]),
        { logger, failurePolicyByHook: { before_tool_call: "fail-closed" } },
      );

      const run = runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
      const captured = run.then(
        () => undefined,
        (err: unknown) => err,
      );

      await vi.advanceTimersByTimeAsync(15_000);
      // Classify with the real downstream helper: a plain Error would fall back
      // to "failed" and misreport the new budget expiry.
      expect(resolveToolExecutionErrorKind(await captured)).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });
});
