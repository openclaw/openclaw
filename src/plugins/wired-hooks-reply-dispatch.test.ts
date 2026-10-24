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
  it.each([
    { outcome: "timeout", captured: false },
    { outcome: "timeout", captured: true },
    { outcome: "declined", captured: true },
    { outcome: "rejected", captured: true },
  ])(
    "closes native requester custody after $outcome (captured admission=$captured)",
    async ({ outcome, captured }) => {
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
                  if (captured) {
                    await nativeSubagentRuntime.spawn({
                      requestId: "first",
                      task: "active first hook",
                    });
                  }
                  detached = late.promise.then(() => {
                    const invoke = () =>
                      nativeSubagentRuntime.spawn({
                        requestId: "reopened",
                        task: "must not start",
                      });
                    if (!captured) {
                      return invoke();
                    }
                    // A plugin can retain the admission capability from its public context.
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
                await nativeSubagentRuntime.spawn({
                  requestId: "current",
                  task: "current request",
                });
                nextStarted.resolve();
                if (captured) {
                  await releaseNext.promise;
                }
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
        captured
          ? withClaimingHookAdmission({ ...replyDispatchCtx }, { assertCurrent() {} })
          : { ...replyDispatchCtx },
        (invoke) =>
          withNativeSubagentRequest(
            () => ({ spawn, collect: async () => ({ completed: [], pending: [] }) }),
            invoke,
          ),
      );
      try {
        await vi.advanceTimersByTimeAsync(5);
        await nextStarted.promise;
        if (!captured) {
          await expect(work).resolves.toMatchObject({ handled: true });
        }
        late.resolve();
        await expect(detached).rejects.toThrow("requester-bound");
        expect(spawn.mock.calls).toEqual([
          ...(captured ? [[{ requestId: "first", task: "active first hook" }]] : []),
          [{ requestId: "current", task: "current request" }],
        ]);
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
      const logger = { warn: vi.fn(), error: vi.fn() };
      const slow = vi.fn(() => new Promise(() => {}));
      const result = {
        handled: true,
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      };
      const succeeding = vi.fn().mockResolvedValue(result);
      const { runner } = createHookRunnerWithRegistry(
        [
          { hookName: "reply_dispatch", handler: slow, timeoutMs: 5 },
          { hookName: "reply_dispatch", handler: succeeding },
        ],
        { logger },
      );
      const run = runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);
      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toEqual(result);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "[hooks] reply_dispatch handler from test-plugin failed: timed out after 5ms",
      );
      expect(succeeding).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
