import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import {
  addStaticTestHooks,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

type PromptHook = Pick<
  PluginHookRegistration<"before_prompt_build">,
  "handler" | "requiresToolAuthority" | "priority" | "timeoutMs"
> & { pluginId?: string };
const phaseEvent = { prompt: "test", messages: [] };
const emptyPrompt = {
  systemPrompt: undefined,
  prependContext: undefined,
  appendContext: undefined,
  prependSystemContext: undefined,
  appendSystemContext: undefined,
};
function promptRunner(hooks: PromptHook[], options?: Parameters<typeof createHookRunner>[1]) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      pluginId: "test",
      hookName: "before_prompt_build" as const,
      source: "test",
      ...hook,
    })),
  );
  return createHookRunner(registry, options);
}
const mockRunner = (
  hooks: Parameters<typeof createMockPluginRegistry>[0],
  options?: Parameters<typeof createHookRunner>[1],
) => createHookRunner(createMockPluginRegistry(hooks), options);
const authority = {
  toolAuthorityFingerprint: "turn-authority",
  activeToolNames: ["message"],
  assertHostActive: () => undefined,
};
afterEach(() => vi.useRealTimers());

describe("prompt phase hooks", () => {
  it("merges context in priority order while keeping the first system prompt", async () => {
    const context = (suffix: string): PluginHookBeforePromptBuildResult => ({
      systemPrompt: `system ${suffix}`,
      prependContext: `context ${suffix}`,
      prependSystemContext: `prepend ${suffix}`,
      appendSystemContext: `append ${suffix}`,
    });
    const runner = promptRunner([
      { priority: 1, handler: () => context("B") },
      { priority: 10, handler: () => context("A") },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toStrictEqual({
      systemPrompt: "system A",
      prependContext: "context A\n\ncontext B",
      appendContext: undefined,
      prependSystemContext: "prepend A\n\nprepend B",
      appendSystemContext: "append A\n\nappend B",
    });
  });

  it.each([
    { name: "explicit empty", toolsAllow: [] },
    { name: "non-array", toolsAllow: null as unknown as string[] },
    { name: "mixed-type array", toolsAllow: ["*", null] as unknown as string[] },
  ])("keeps $name tool restrictions closed", async ({ toolsAllow }) => {
    const runner = promptRunner([
      { handler: () => ({ toolsAllow }) },
      { handler: () => ({ toolsAllow: ["read"] }) },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toStrictEqual({
      ...emptyPrompt,
      toolsAllow: [],
    });
  });

  it("preserves overlapping frozen restrictions for the concrete tool surface", async () => {
    const runner = promptRunner([
      {
        handler: () => ({
          toolsAllow: Object.freeze(["group:fs", "web_*"]) as unknown as string[],
        }),
      },
      { handler: () => ({ toolsAllow: ["read", "*_search"] }) },
    ]);
    const toolsAllow = (await runner.runBeforePromptBuild(phaseEvent, {}))?.toolsAllow;
    expect(toolsAllow).toBeDefined();
    expect(readToolAllowlistIntersection(toolsAllow ?? [])).toEqual([
      ["group:fs", "web_*"],
      ["read", "*_search"],
    ]);
    expect(
      applyEmbeddedAttemptToolsAllow(
        ["read", "web_search", "web_fetch", "memory_search"].map((name) => ({ name })),
        toolsAllow,
      ),
    ).toEqual([{ name: "read" }, { name: "web_search" }]);
  });

  it("enriches only after host authorization and expires the supplied authority", async () => {
    const enrichment = vi.fn<PromptHook["handler"]>((_event, ctx) => {
      expect(ctx.toolAuthority?.allows("memory_search")).toBe(false);
      expect(ctx.toolAuthority?.allows("message")).toBe(true);
      return { prependContext: "authorized context", systemPrompt: "ignored override" };
    });
    const runner = promptRunner([
      { handler: () => ({ toolsAllow: ["message"] }) },
      { requiresToolAuthority: true, handler: enrichment },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toMatchObject({
      toolsAllow: ["message"],
    });
    expect(enrichment).not.toHaveBeenCalled();
    await expect(runner.runAuthorizedPromptBuild(phaseEvent, {}, authority)).resolves.toEqual({
      prependContext: "authorized context",
    });
    const retained = enrichment.mock.calls[0]?.[1].toolAuthority;
    expect(() => retained?.assertActive()).toThrow("no longer active");
  });

  it("rejects stale enrichment and never starts its successor after host authority closes", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    const later = vi.fn(() => ({ prependContext: "later context" }));
    const runner = promptRunner([
      {
        requiresToolAuthority: true,
        handler: async () => {
          started.resolve();
          await gate.promise;
          return { prependContext: "stale context" };
        },
      },
      { requiresToolAuthority: true, handler: later },
    ]);
    let active = true;
    const run = runner.runAuthorizedPromptBuild(
      phaseEvent,
      {},
      {
        ...authority,
        assertHostActive: () => {
          if (!active) {
            throw new Error("host turn authority is no longer active");
          }
        },
      },
    );
    await started.promise;
    active = false;
    gate.resolve();
    await expect(run).rejects.toThrow("host turn authority is no longer active");
    expect(later).not.toHaveBeenCalled();
  });
});

type PromptPhase = "ordinary" | "authorized";
type Invocation = PluginHookAgentContext["hookInvocation"];

function isActive(invocation: Invocation): boolean | undefined {
  if (!invocation) {
    return undefined;
  }
  try {
    invocation.assertActive();
    return true;
  } catch {
    return false;
  }
}

function phaseDispatch(
  phase: PromptPhase,
  hooks: PromptHook[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
) {
  const runner = promptRunner(
    hooks.map((hook) => ({
      ...hook,
      ...(phase === "authorized" ? { requiresToolAuthority: true as const } : {}),
    })),
    { logger, modifyingHookTimeoutMsByHook: { before_prompt_build: 100 } },
  );
  return (context: PluginHookAgentContext) =>
    phase === "ordinary"
      ? runner.runBeforePromptBuild(phaseEvent, context)
      : runner.runAuthorizedPromptBuild(phaseEvent, context, {
          ...authority,
          activeToolNames: ["memory_search"],
        });
}

describe("prompt hook invocation", () => {
  it.each([
    { phase: "ordinary", outcome: "returned" },
    { phase: "ordinary", outcome: "threw" },
    { phase: "authorized", outcome: "rejected" },
  ] as const)(
    "revokes a $phase $outcome handler before result merging or error handling",
    async ({ phase, outcome }) => {
      const context = Object.freeze({ agentId: "test-agent", sessionKey: "test-session" });
      let handlerContext: PluginHookAgentContext = {};
      let activeOnEntry: boolean | undefined;
      const activeAtMerge: Array<boolean | undefined> = [];
      const activeAtError: Array<boolean | undefined> = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtError.push(isActive(handlerContext.hookInvocation));
        }),
      };
      const handler: PromptHook["handler"] = (_event, ctx) => {
        handlerContext = ctx;
        activeOnEntry = isActive(ctx.hookInvocation);
        const failure = new Error("synthetic handler failure");
        if (outcome === "threw") {
          throw failure;
        }
        if (outcome === "rejected") {
          return Promise.reject(failure);
        }
        return {
          get prependContext() {
            activeAtMerge.push(isActive(ctx.hookInvocation));
            return "timely context";
          },
        };
      };
      const dispatch = phaseDispatch(phase, [{ pluginId: "settling-handler", handler }], logger);
      expect(await dispatch(context)).toEqual(
        outcome === "returned" ? { prependContext: "timely context" } : undefined,
      );
      expect(activeOnEntry).toBe(true);
      expect(handlerContext).not.toBe(context);
      expect(context).toEqual({ agentId: "test-agent", sessionKey: "test-session" });
      expect(context).not.toHaveProperty("hookInvocation");
      expect(isActive(handlerContext.hookInvocation)).toBe(false);
      if (outcome === "returned") {
        expect(activeAtMerge.length).toBeGreaterThan(0);
        expect(activeAtMerge.every((active) => active === false)).toBe(true);
        expect(activeAtError).toEqual([]);
      } else {
        expect(activeAtMerge).toEqual([]);
        expect(activeAtError).toEqual([false]);
      }
    },
  );

  it.each(["ordinary", "authorized"] as const)(
    "expires only the timed-out %s handler while its next sibling is still active",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstGate = createDeferred();
      const secondGate = createDeferred();
      const contexts: PluginHookAgentContext[] = [];
      const context = Object.freeze({ agentId: "test-agent" });
      let firstResumed = false;
      let firstActiveAtSecondEntry: boolean | undefined;
      const activeAtTimeout: Array<boolean | undefined> = [];
      const firstWork = firstGate.promise.then(() => {
        firstResumed = true;
        return { prependContext: "discarded late context" };
      });
      const secondWork = secondGate.promise.then(() => ({ prependContext: "live context" }));
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtTimeout.push(isActive(contexts[0]?.hookInvocation));
        }),
      };
      const dispatch = phaseDispatch(
        phase,
        [
          {
            pluginId: "timed-out-handler",
            timeoutMs: 5,
            handler: (_event, ctx) => {
              contexts.push(ctx);
              return firstWork;
            },
          },
          {
            pluginId: "live-sibling",
            handler: (_event, ctx) => {
              firstActiveAtSecondEntry = isActive(contexts[0]?.hookInvocation);
              contexts.push(ctx);
              return secondWork;
            },
          },
        ],
        logger,
      );
      const run = dispatch(context);
      try {
        expect(contexts).toHaveLength(1);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(true);
        await vi.advanceTimersByTimeAsync(5);
        expect(contexts).toHaveLength(2);
        expect(activeAtTimeout).toEqual([false]);
        expect(firstActiveAtSecondEntry).toBe(false);
        expect(contexts[0]?.hookInvocation).not.toBe(contexts[1]?.hookInvocation);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        expect(context).not.toHaveProperty("hookInvocation");
        expect(firstResumed).toBe(false);

        firstGate.resolve();
        await Promise.allSettled([firstWork]);
        expect(firstResumed).toBe(true);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        secondGate.resolve();
        await expect(run).resolves.toEqual({ prependContext: "live context" });
        expect(isActive(contexts[1]?.hookInvocation)).toBe(false);
      } finally {
        firstGate.resolve();
        secondGate.resolve();
        await Promise.allSettled([firstWork, secondWork, run]);
      }
    },
  );
});

const promptEvent = (prompt: string) => ({ prompt, messages: [] });

describe("before_prompt_build dispatch", () => {
  it("keeps sibling hook families and other runners active during dispatch", async () => {
    const turnPrepare = vi.fn(() => ({ prependContext: "turn" }));
    const heartbeat = vi.fn(() => ({ appendContext: "heartbeat" }));
    const otherPromptBuild = vi.fn(() => ({ prependContext: "other runner" }));
    const otherRunner = promptRunner([{ handler: otherPromptBuild, pluginId: "other" }]);
    const promptBuild = vi.fn(async () => {
      await runner.runAgentTurnPrepare(
        { prompt: "nested", messages: [], queuedInjections: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      await runner.runHeartbeatPromptContribution(
        { heartbeatName: "heartbeat" },
        TEST_PLUGIN_AGENT_CTX,
      );
      await otherRunner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return {};
    });
    const runner = mockRunner([
      { hookName: "before_prompt_build", handler: promptBuild, pluginId: "prompt" },
      { hookName: "agent_turn_prepare", handler: turnPrepare, pluginId: "turn" },
      { hookName: "heartbeat_prompt_contribution", handler: heartbeat, pluginId: "heartbeat" },
    ]);

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);

    expect(promptBuild).toHaveBeenCalledOnce();
    expect(turnPrepare).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(otherPromptBuild).toHaveBeenCalledOnce();
  });

  it("allows detached descendants to dispatch after the outer call settles", async () => {
    const detachedGate = createDeferred();
    let detachedDispatch: Promise<unknown> | undefined;
    const promptBuild = vi.fn(async (event: unknown) => {
      const prompt = (event as { prompt: string }).prompt;
      if (prompt === "outer") {
        detachedDispatch = (async () => {
          await detachedGate.promise;
          return await runner.runBeforePromptBuild(promptEvent("detached"), TEST_PLUGIN_AGENT_CTX);
        })();
      }
      return { prependContext: prompt };
    });
    const runner = promptRunner([{ handler: promptBuild, pluginId: "prompt" }]);

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);
    detachedGate.resolve();
    expect(detachedDispatch).toBeDefined();
    await expect(detachedDispatch).resolves.toEqual({
      ...emptyPrompt,
      prependContext: "detached",
    });
    expect(promptBuild).toHaveBeenCalledTimes(2);
  });
});

const finalizeEvent = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  lastAssistantMessage: "done",
};
function finalize(...results: PluginHookBeforeAgentFinalizeResult[]) {
  return mockRunner(
    results.map((result) => ({ hookName: "before_agent_finalize", handler: () => result })),
  ).runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
}
const retry = (instruction: string, idempotencyKey: string, maxAttempts = 1) => ({
  instruction,
  idempotencyKey,
  maxAttempts,
});
const revise = (reason: string, candidate: PluginHookBeforeAgentFinalizeResult["retry"]) => ({
  action: "revise" as const,
  reason,
  retry: candidate,
});

describe("before_agent_finalize", () => {
  it("retains valid retry candidates in order while discarding invalid instructions", async () => {
    const result = await finalize(
      { action: "revise", reason: "empty", retry: { instruction: "   ", idempotencyKey: "empty" } },
      revise("malformed", { instruction: 123, idempotencyKey: "bad" } as never),
      revise("artifacts", retry(" regenerate artifacts ", "artifacts")),
      revise("tests", retry("rerun tests", "tests")),
    );
    expect(result).toEqual({
      action: "revise",
      reason: "empty\n\nmalformed\n\nartifacts\n\ntests",
      retry: retry("regenerate artifacts", "artifacts"),
    });
    expect(Object.getOwnPropertyDescriptor(result, "retryCandidates")).toMatchObject({
      enumerable: false,
      value: [retry("regenerate artifacts", "artifacts"), retry("rerun tests", "tests")],
    });
  });

  it("lets finalize override revise decisions", async () => {
    await expect(
      finalize(
        { action: "revise", reason: "keep going" },
        { action: "finalize", reason: "enough" },
      ),
    ).resolves.toEqual({ action: "finalize", reason: "enough" });
  });

  it("bounds hung handlers so the original final answer can proceed", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const runner = mockRunner(
      [{ hookName: "before_agent_finalize", handler: () => new Promise(() => {}) }],
      { logger },
    );
    const run = runner.runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(run).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 15000ms"));
  });
});

it.each([
  { higher: [], lower: ["local/backup"], priority: 10, expected: [] },
  { higher: ["local/backup"], lower: [], priority: 10, expected: ["local/backup"] },
  { higher: undefined, lower: ["local/backup"], priority: 10, expected: ["local/backup"] },
  { higher: [], lower: ["local/first"], priority: 0, expected: ["local/first"] },
  { higher: null as unknown as string[], lower: ["local/backup"], priority: 10, expected: [] },
])(
  "keeps the first defined routing overrides after a broken plugin ($priority)",
  async ({ higher, lower, priority, expected }) => {
    const registry = createEmptyPluginRegistry();
    const broken = vi.fn(() => {
      throw new Error("plugin crashed");
    });
    const routing = (prefix: string, fallbacksOverride: string[] | undefined) => ({
      modelOverride: `${prefix}-model`,
      providerOverride: `${prefix}-provider`,
      fallbacksOverride,
    });
    addStaticTestHooks(registry, {
      hookName: "before_model_resolve",
      hooks: [
        { pluginId: "low", result: routing("low", lower) },
        { pluginId: "broken", priority: 100, result: {}, handler: broken },
        { pluginId: "high", priority, result: routing("high", higher) },
      ],
    });
    await expect(
      createHookRunner(registry).runBeforeModelResolve({ prompt: "test" }, TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      modelOverride: priority ? "high-model" : "low-model",
      providerOverride: priority ? "high-provider" : "low-provider",
      fallbacksOverride: expected,
    });
    expect(broken).toHaveBeenCalledOnce();
  },
);
