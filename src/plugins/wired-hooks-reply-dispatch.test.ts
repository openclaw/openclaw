// Covers wired plugin hook dispatch before replies.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import type {
  PluginHookRegistrationOptions,
  PluginHookReplyDispatchContext,
} from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import {
  nativeSubagentRuntime,
  withNativeSubagentRequest,
  withNativeSubagentRuntimeGuard,
} from "./runtime/native-subagent-context.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const replyDispatchEvent = {
  ctx: buildTestCtx({ SessionKey: "agent:test:session", BodyForAgent: "hello" }),
  sessionKey: "agent:test:session",
  inboundAudio: false,
  shouldRouteToOriginating: false,
  shouldSendToolSummaries: true,
  shouldSendFullToolDetails: false,
  sendPolicy: "allow" as const,
};

const replyDispatchCtx = {
  cfg: {},
  dispatcher: {
    sendToolResult: () => false,
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  },
  recordProcessed: () => {},
  markIdle: () => {},
};

function firstErrorLog(logger: { error: ReturnType<typeof vi.fn> }) {
  return logger.error.mock.calls[0];
}

function createRegisteredReplyHook(eligibleDispatchKinds: unknown) {
  const builder = createTestPluginRegistry();
  const api = builder.createApi(createPluginRecord({ id: "scoped-dispatch", origin: "bundled" }), {
    config: {},
  });
  const result = { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  const handler = vi.fn(() => result);
  const options: PluginHookRegistrationOptions<"reply_dispatch"> = {};
  // JavaScript plugins can supply invalid metadata despite the typed registration contract.
  Reflect.set(options, "eligibleDispatchKinds", eligibleDispatchKinds);
  api.on("reply_dispatch", handler, options);
  return { handler, result, runner: createHookRunner(builder.registry) };
}

describe("reply_dispatch hook runner", () => {
  it("closes native requester custody at timeout before advancing to another hook", async () => {
    vi.useFakeTimers();
    const late = createDeferred();
    const spawn = vi.fn().mockResolvedValue({
      runId: "child",
      childSessionKey: "agent:test:subagent:child",
      completionMode: "collect" as const,
    });
    let detached: Promise<unknown> | undefined;
    const { registry, runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "reply_dispatch",
          handler: async () =>
            withNativeSubagentRuntimeGuard({ pluginId: "slow", assertCurrent() {} }, async () => {
              detached = late.promise.then(() =>
                nativeSubagentRuntime.spawn({ requestId: "late", task: "must not start" }),
              );
              await new Promise(() => {});
            }),
        },
        {
          hookName: "reply_dispatch",
          handler: async () =>
            withNativeSubagentRuntimeGuard({ pluginId: "next", assertCurrent() {} }, async () => {
              await nativeSubagentRuntime.spawn({ requestId: "current", task: "current request" });
              return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            }),
        },
      ],
      { logger: { error: vi.fn(), warn: vi.fn() } },
    );
    expectDefined(registry.typedHooks[0], "slow handler").timeoutMs = 5;
    try {
      const work = runner.runReplyDispatch(replyDispatchEvent, { ...replyDispatchCtx }, (invoke) =>
        withNativeSubagentRequest(
          () => ({ spawn, collect: async () => ({ completed: [], pending: [] }) }),
          invoke,
        ),
      );
      await vi.advanceTimersByTimeAsync(5);
      await expect(work).resolves.toMatchObject({ handled: true });
      late.resolve();
      await expect(detached).rejects.toThrow("requester-bound");
      expect(spawn).toHaveBeenCalledExactlyOnceWith({
        requestId: "current",
        task: "current request",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["timeout", "declined", "rejected"] as const)(
    "cannot reopen native requester custody from a captured context after %s",
    async (outcome) => {
      vi.useFakeTimers();
      const late = createDeferred();
      const nextStarted = createDeferred();
      const releaseFirst = createDeferred();
      const releaseNext = createDeferred();
      const spawn = vi.fn().mockResolvedValue({
        runId: "child",
        childSessionKey: "agent:test:subagent:child",
        completionMode: "collect" as const,
      });
      let detached: Promise<unknown> | undefined;
      const { runner } = createHookRunnerWithRegistry(
        [
          {
            hookName: "reply_dispatch",
            pluginId: "first",
            timeoutMs: 5,
            handler: async (_event, context) =>
              withNativeSubagentRuntimeGuard(
                { pluginId: "first", assertCurrent() {} },
                async () => {
                  await nativeSubagentRuntime.spawn({
                    requestId: "first",
                    task: "active first hook",
                  });
                  detached = late.promise.then(() => {
                    const invoke = () =>
                      nativeSubagentRuntime.spawn({
                        requestId: "reopened",
                        task: "must not start",
                      });
                    // Exercise the capability that a plugin could retain from the public context.
                    if (!context || typeof context !== "object") {
                      throw new Error("reply hook context was not supplied");
                    }
                    const admission = Reflect.get(
                      context,
                      Symbol.for("openclaw.claimingHookAdmission"),
                    );
                    return typeof admission?.run === "function" ? admission.run(invoke) : invoke();
                  });
                  if (outcome === "timeout") {
                    await releaseFirst.promise;
                  }
                  if (outcome === "rejected") {
                    throw new Error("first hook failed");
                  }
                },
              ),
          },
          {
            hookName: "reply_dispatch",
            pluginId: "next",
            handler: async () =>
              withNativeSubagentRuntimeGuard({ pluginId: "next", assertCurrent() {} }, async () => {
                await nativeSubagentRuntime.spawn({ requestId: "next", task: "active next hook" });
                nextStarted.resolve();
                await releaseNext.promise;
                return {
                  handled: true,
                  queuedFinal: false,
                  counts: { tool: 0, block: 0, final: 0 },
                };
              }),
          },
        ],
        { logger: { error: vi.fn(), warn: vi.fn() } },
      );
      const work = runner.runReplyDispatch(
        replyDispatchEvent,
        withClaimingHookAdmission({ ...replyDispatchCtx }, { assertCurrent() {} }),
        (invoke) =>
          withNativeSubagentRequest(
            () => ({ spawn, collect: async () => ({ completed: [], pending: [] }) }),
            invoke,
          ),
      );
      try {
        await vi.advanceTimersByTimeAsync(5);
        await nextStarted.promise;
        late.resolve();
        await expect(detached).rejects.toThrow("requester-bound");
        expect(spawn.mock.calls.map(([params]) => params.requestId)).toEqual(["first", "next"]);
        releaseNext.resolve();
        await expect(work).resolves.toMatchObject({ handled: true });
      } finally {
        releaseFirst.resolve();
        releaseNext.resolve();
        await work;
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { dispatchKind: "agent", eligible: false },
    { dispatchKind: "acp", eligible: true },
    { dispatchKind: "unknown-runtime", eligible: true },
  ])(
    "keeps invocation and presence checks aligned for $dispatchKind",
    async ({ dispatchKind, eligible }) => {
      const { handler, result, runner } = createRegisteredReplyHook(["acp"]);
      const ctx: PluginHookReplyDispatchContext = { ...replyDispatchCtx };
      Reflect.set(ctx, "dispatchKind", dispatchKind);

      expect(runner.hasHooks("reply_dispatch", ctx)).toBe(eligible);
      await expect(runner.runReplyDispatch(replyDispatchEvent, ctx)).resolves.toEqual(
        eligible ? result : undefined,
      );
      expect(handler).toHaveBeenCalledTimes(eligible ? 1 : 0);
    },
  );

  it.each([undefined, ["acp", "unknown-runtime"]].map((eligibility) => ({ eligibility })))(
    "keeps omitted or malformed dispatch eligibility unscoped ($eligibility)",
    async ({ eligibility }) => {
      const { handler, result, runner } = createRegisteredReplyHook(eligibility);
      const ctx: PluginHookReplyDispatchContext = { ...replyDispatchCtx, dispatchKind: "agent" };

      expect(runner.hasHooks("reply_dispatch", { dispatchKind: "agent" })).toBe(true);
      await expect(runner.runReplyDispatch(replyDispatchEvent, ctx)).resolves.toEqual(result);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("honors per-hook registration timeouts and continues to the next handler", async () => {
    vi.useFakeTimers();
    try {
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };
      const slow = vi.fn(() => new Promise(() => {}));
      const succeeding = vi.fn().mockResolvedValue({
        handled: true,
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      });
      const { registry, runner } = createHookRunnerWithRegistry(
        [
          { hookName: "reply_dispatch", handler: slow },
          { hookName: "reply_dispatch", handler: succeeding },
        ],
        { logger },
      );
      expectDefined(registry.typedHooks[0], "registry.typedHooks[0] test invariant").timeoutMs = 5;

      const run = runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);
      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toEqual({
        handled: true,
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(firstErrorLog(logger)).toEqual([
        "[hooks] reply_dispatch handler from test-plugin failed: timed out after 5ms",
      ]);
      expect(succeeding).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
