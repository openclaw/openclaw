import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

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

function createRunner(
  phase: PromptPhase,
  hooks: PluginHookRegistration<"before_prompt_build">[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      ...hook,
      ...(phase === "authorized" ? { requiresToolAuthority: true as const } : {}),
    })),
  );
  return createHookRunner(registry, {
    logger,
    modifyingHookTimeoutMsByHook: { before_prompt_build: 100 },
  });
}

function dispatch(
  runner: ReturnType<typeof createHookRunner>,
  phase: PromptPhase,
  context: PluginHookAgentContext,
) {
  const event = { prompt: "synthetic prompt", messages: [] };
  return phase === "ordinary"
    ? runner.runBeforePromptBuild(event, context)
    : runner.runAuthorizedPromptBuild(event, context, {
        toolAuthorityFingerprint: "synthetic-turn-authority",
        activeToolNames: ["memory_search"],
        assertHostActive: () => undefined,
      });
}

describe.each(["ordinary", "authorized"] as const)("%s prompt hook invocation", (phase) => {
  it.each(["returned", "threw", "rejected"] as const)(
    "revokes a %s handler before result merging or error handling",
    async (outcome) => {
      const context = Object.freeze({ agentId: "test-agent", sessionKey: "test-session" });
      let handlerContext: PluginHookAgentContext = {};
      let activeOnEntry: boolean | undefined;
      const activeAtMerge: Array<boolean | undefined> = [];
      const activeAtError: Array<boolean | undefined> = [];
      const pending: Promise<unknown>[] = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtError.push(isActive(handlerContext.hookInvocation));
        }),
      };
      const runner = createRunner(
        phase,
        [
          {
            pluginId: "settling-handler",
            hookName: "before_prompt_build",
            source: "test",
            handler: (_event, ctx) => {
              handlerContext = ctx;
              activeOnEntry = isActive(ctx.hookInvocation);
              const failure = new Error("synthetic handler failure");
              if (outcome === "threw") {
                throw failure;
              }
              if (outcome === "rejected") {
                const work = Promise.reject(failure);
                pending.push(work);
                void work.catch(() => {});
                return work;
              }
              return {
                get prependContext() {
                  activeAtMerge.push(isActive(ctx.hookInvocation));
                  return "timely context";
                },
              };
            },
          },
        ],
        logger,
      );
      const run = dispatch(runner, phase, context);
      try {
        expect(await run).toEqual(
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
      } finally {
        await Promise.allSettled([...pending, run]);
      }
    },
  );

  it("expires only the timed-out handler while its next sibling is still active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const firstGate = createDeferredCore();
    const secondGate = createDeferredCore();
    const pending: Promise<unknown>[] = [];
    const contexts: PluginHookAgentContext[] = [];
    const context = Object.freeze({ agentId: "test-agent" });
    let firstResumed = false;
    let firstActiveAtSecondEntry: boolean | undefined;
    const activeAtTimeout: Array<boolean | undefined> = [];
    const logger = {
      warn: vi.fn(),
      error: vi.fn(() => {
        activeAtTimeout.push(isActive(contexts[0]?.hookInvocation));
      }),
    };
    const runner = createRunner(
      phase,
      [
        {
          pluginId: "timed-out-handler",
          hookName: "before_prompt_build",
          source: "test",
          timeoutMs: 5,
          handler: (_event, ctx) => {
            contexts.push(ctx);
            const work = firstGate.promise.then(() => {
              firstResumed = true;
              return { prependContext: "discarded late context" };
            });
            pending.push(work);
            return work;
          },
        },
        {
          pluginId: "live-sibling",
          hookName: "before_prompt_build",
          source: "test",
          handler: (_event, ctx) => {
            firstActiveAtSecondEntry = isActive(contexts[0]?.hookInvocation);
            contexts.push(ctx);
            const work = secondGate.promise.then(() => ({ prependContext: "live context" }));
            pending.push(work);
            return work;
          },
        },
      ],
      logger,
    );
    const run = dispatch(runner, phase, context);
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
      await Promise.allSettled(pending.slice(0, 1));
      expect(firstResumed).toBe(true);
      expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
      expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
      secondGate.resolve();
      await expect(run).resolves.toEqual({ prependContext: "live context" });
      expect(isActive(contexts[1]?.hookInvocation)).toBe(false);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      try {
        await Promise.allSettled([...pending, run]);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
