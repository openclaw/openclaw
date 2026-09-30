import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginHookBeforeToolCallResult, PluginHookRegistration } from "./types.js";

type Handler = PluginHookRegistration<"before_tool_call">["handler"];
type ToolHook = Pick<
  PluginHookRegistration<"before_tool_call">,
  "handler" | "matcher" | "priority"
> & { pluginId?: string };
const event = { toolName: "bash", params: { command: "safe" } };
const ctx = { toolName: "bash", agentId: "main", sessionKey: "agent:main:main" };
const approval = { title: "Needs approval", description: "Approval needed" };
function toolRunner(hooks: ToolHook[], options?: Parameters<typeof createHookRunner>[1]) {
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({ registry, hookName: "before_tool_call", pluginId: "policy", ...hook });
  }
  return createHookRunner(registry, options);
}

describe("before_tool_call isolation and approval", () => {
  it("binds the first approval to its owner and snapshot while allowing a later block", async () => {
    const params = { command: "safe" };
    const skipped = vi.fn<Handler>(() => ({ block: false, params: { command: "injected" } }));
    const runner = toolRunner([
      {
        priority: 100,
        handler: () => ({ params, requireApproval: { ...approval, pluginId: "spoofed" } }),
      },
      {
        priority: 50,
        pluginId: "late",
        handler: () => {
          params.command = "mutated";
          return {
            params: { command: "late override" },
            requireApproval: { title: "Late", description: "Late" },
          };
        },
      },
      {
        handler: () => ({
          block: true,
          blockReason: "blocked",
          params: { command: "blocked override" },
        }),
      },
      { handler: skipped },
    ]);
    await expect(runner.runBeforeToolCall(event, ctx)).resolves.toEqual({
      params: { command: "safe" },
      block: true,
      blockReason: "blocked",
      requireApproval: { ...approval, pluginId: "policy" },
    });
    expect(skipped).not.toHaveBeenCalled();
  });

  it("isolates direct event mutations from the caller and later handlers", async () => {
    const original = { toolName: "bash", params: { command: "safe" } };
    const observer = vi.fn<Handler>(() => ({}));
    await toolRunner([
      { handler: () => ({ requireApproval: approval }) },
      {
        handler: (value) => {
          value.params.cwd = "/unapproved";
          return {};
        },
      },
      { handler: observer },
    ]).runBeforeToolCall(original, ctx);
    expect(original.params).toEqual({ command: "safe" });
    expect(observer.mock.calls[0]?.[0].params).toEqual({ command: "safe" });
  });

  it.each([
    { name: "uncloneable callback", params: { callback: () => undefined } },
    {
      name: "shared WebAssembly memory",
      params: { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) },
    },
  ])("fails closed before invoking a handler for $name", async ({ params }) => {
    const handler = vi.fn<Handler>(() => ({}));
    await expect(
      toolRunner([{ handler }], { catchErrors: true }).runBeforeToolCall(
        { toolName: "bash", params },
        ctx,
      ),
    ).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("clones collections without invoking overridden iterators", async () => {
    class HostileMap extends Map {
      override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
        throw new Error("overridden map iterator");
      }
    }
    class HostileSet extends Set {
      override [Symbol.iterator](): SetIterator<unknown> {
        throw new Error("overridden set iterator");
      }
    }
    const map = new HostileMap();
    const set = new HostileSet();
    Map.prototype.set.call(map, "key", "value");
    Set.prototype.add.call(set, "value");
    const handler = vi.fn<Handler>(() => ({}));
    await toolRunner([{ handler }]).runBeforeToolCall(
      { toolName: "bash", params: { map, set } },
      ctx,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].params).toEqual({
      map: new Map([["key", "value"]]),
      set: new Set(["value"]),
    });
  });

  it("does not enumerate typed-array elements during isolation", async () => {
    const bytes = new Uint8Array(1024 * 1024);
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    const handler = vi.fn<Handler>(() => ({}));
    try {
      await toolRunner([{ handler }]).runBeforeToolCall(
        { toolName: "bash", params: { bytes } },
        ctx,
      );
      expect(handler).toHaveBeenCalledOnce();
      expect(ownKeys.mock.calls.some(([value]) => ArrayBuffer.isView(value))).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it("fails closed before later hooks when approved params cannot be snapshotted", async () => {
    const skipped = vi.fn<Handler>(() => ({}));
    const run = toolRunner(
      [
        { handler: () => ({ params: { callback: () => undefined }, requireApproval: approval }) },
        { handler: skipped },
      ],
      { catchErrors: true },
    ).runBeforeToolCall(event, ctx);
    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(skipped).not.toHaveBeenCalled();
  });
});

describe("before_tool_call receipts", () => {
  let receipts: DecisionReceiptV1[];
  let clear: () => void;
  beforeEach(() => {
    receipts = [];
    clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
  });
  afterEach(() => {
    clear();
  });
  const admission = (assertAuthority: () => boolean | void = () => true) => ({
    token: createExecutionIdentityAdmissionToken("run-hook", {
      contextId: "context-hook",
      executionId: "execution-hook",
      now: 100,
    }),
    assertAuthority,
  });

  it.each([
    { result: { params: { approved: true } }, outcome: "allowed", reason: "plugin_hook_allowed" },
    {
      result: { block: true, blockReason: "policy denied" },
      outcome: "denied",
      reason: "plugin_hook_blocked",
    },
  ] as const)("records a redacted $outcome decision", async ({ result, outcome, reason }) => {
    await toolRunner([{ pluginId: "secret-plugin-id", handler: () => result }]).runBeforeToolCall(
      { toolName: "secret-tool-name", params: {} },
      { ...ctx, toolName: "secret-tool-name" },
      admission(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      action: { family: "plugin", operation: "before_tool_call" },
      decision: { outcome, reasonCode: reason },
      enforcement: { coverageState: "enforced" },
      source: { owner: "plugin-hook" },
    });
    expect(JSON.stringify(receipts)).not.toContain("secret-plugin-id");
    expect(JSON.stringify(receipts)).not.toContain("secret-tool-name");
  });

  it.each([
    {
      name: "caught failure",
      failurePolicy: undefined,
      sharedMemory: false,
      rejects: false,
      outcome: "unknown",
      coverage: "unknown",
      reason: "plugin_hook_failed_open",
    },
    {
      name: "configured denial",
      failurePolicy: "fail-closed",
      sharedMemory: false,
      rejects: true,
      outcome: "denied",
      coverage: "enforced",
      reason: "plugin_hook_failed_closed",
    },
    {
      name: "shared memory hidden in Error.cause",
      failurePolicy: undefined,
      sharedMemory: true,
      rejects: true,
      outcome: "denied",
      coverage: "enforced",
      reason: "plugin_hook_failed_closed",
    },
  ] as const)(
    "records $name without exposing secrets",
    async ({ failurePolicy, sharedMemory, rejects, outcome, coverage, reason }) => {
      const handler = vi.fn<Handler>(() => {
        throw new Error("credential=must-not-leak");
      });
      const runner = toolRunner(
        [{ pluginId: "failing-plugin", handler }],
        failurePolicy ? { failurePolicyByHook: { before_tool_call: failurePolicy } } : undefined,
      );
      const params = sharedMemory
        ? { error: new Error("shared", { cause: new Uint8Array(new SharedArrayBuffer(4)) }) }
        : {};
      const run = runner.runBeforeToolCall({ toolName: "bash", params }, ctx, admission());
      if (rejects) {
        await expect(run).rejects.toThrow(
          sharedMemory
            ? "before_tool_call mutable input isolation failed"
            : "before_tool_call handler from failing-plugin failed",
        );
      } else {
        await expect(run).resolves.toBeUndefined();
      }
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        decision: { outcome, reasonCode: reason },
        enforcement: { coverageState: coverage },
      });
      expect(JSON.stringify(receipts)).not.toContain("must-not-leak");
      expect(handler).toHaveBeenCalledTimes(sharedMemory ? 0 : 1);
    },
  );

  it.each([
    { settlement: "resolve", authority: "reports stale" },
    { settlement: "reject", authority: "throws" },
  ] as const)(
    "suppresses a deferred $settlement receipt when authority $authority",
    async ({ settlement, authority }) => {
      const pending = createDeferred<PluginHookBeforeToolCallResult>();
      const runner = toolRunner([{ pluginId: "deferred-plugin", handler: () => pending.promise }], {
        failurePolicyByHook: { before_tool_call: "fail-closed" },
      });
      const run = runner.runBeforeToolCall(
        event,
        ctx,
        admission(() => {
          if (authority === "throws") {
            throw new Error("stale receipt authority");
          }
          return false;
        }),
      );
      if (settlement === "resolve") {
        pending.resolve({});
        await expect(run).resolves.toEqual({});
      } else {
        pending.reject(new Error("deferred hook failure"));
        await expect(run).rejects.toThrow("deferred-plugin failed");
      }
      expect(receipts).toEqual([]);
    },
  );
});

describe("tool matcher scoping", () => {
  it("skips uncovered tools and invokes a canonical matcher once", async () => {
    const handler = vi.fn<Handler>(() => ({ block: true, blockReason: "covered" }));
    const runner = toolRunner([{ matcher: ["exec"], handler }]);
    await expect(
      runner.runBeforeToolCall({ toolName: "web_search", params: {} }, { toolName: "web_search" }),
    ).resolves.toBeUndefined();
    await expect(
      runner.runBeforeToolCall({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toMatchObject({ block: true, blockReason: "covered" });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("rejects provider matcher aliases", async () => {
    const handler = vi.fn<Handler>(() => ({ block: true }));
    await expect(
      toolRunner([{ matcher: ["Agent"], handler }]).runBeforeToolCall(
        { toolName: "spawn_agent", params: {} },
        { toolName: "spawn_agent" },
      ),
    ).rejects.toThrow("tool hook matcher entries must use canonical OpenClaw tool ids");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("hook security", () => {
  it("sanitizes caught hook error logs", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "message_received",
          handler: () => {
            throw new Error("boom\nforged\tsecret sk-test1234567890");
          },
        },
      ]),
      { logger },
    );
    await runner.runMessageReceived({ from: "user-1", content: "hi" }, { channelId: "whatsapp" });
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]?.[0];
    expect(message).toMatch(/failed: boom forged secret/);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("sk-test1234567890");
  });

  it("retains accumulated message content when a later hook cancels and skips successors", async () => {
    const skipped = vi.fn(() => ({ cancel: false, content: "injected" }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "message_sending", handler: () => ({ content: "first", cancel: false }) },
        { hookName: "message_sending", handler: () => ({ content: "second", cancel: false }) },
        { hookName: "message_sending", handler: () => ({ cancel: true }) },
        { hookName: "message_sending", handler: skipped },
      ]),
    );
    await expect(
      runner.runMessageSending({ to: "user-1", content: "hello" }, { channelId: "forum" }),
    ).resolves.toEqual({ content: "second", cancel: true });
    expect(skipped).not.toHaveBeenCalled();
  });
});
