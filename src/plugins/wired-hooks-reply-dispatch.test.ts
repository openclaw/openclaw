import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
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
const handledResult = {
  handled: true,
  queuedFinal: false,
  counts: { tool: 1, block: 0, final: 0 },
};
const guard = <T>(pluginId: string, run: () => T) =>
  withNativeSubagentRuntimeGuard({ pluginId, assertCurrent() {} }, run);

describe("reply_dispatch hook runner", () => {
  it.each([
    { outcome: "timeout", overlap: false },
    { outcome: "timeout", overlap: true },
    { outcome: "declined", overlap: true },
    { outcome: "rejected", overlap: true },
  ])(
    "closes native requester custody after $outcome (active next hook=$overlap)",
    async ({ outcome, overlap }) => {
      vi.useFakeTimers();
      const late = createDeferred();
      const nextStarted = createDeferred();
      const releaseFirst = createDeferred();
      const releaseNext = createDeferred();
      const logger = { error: vi.fn(), warn: vi.fn() };
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
            handler: async () =>
              guard("first", async () => {
                if (overlap) {
                  await nativeSubagentRuntime.spawn({ requestId: "first", task: "active" });
                }
                detached = late.promise.then(() =>
                  nativeSubagentRuntime.spawn({ requestId: "reopened", task: "blocked" }),
                );
                if (outcome === "timeout") {
                  await releaseFirst.promise;
                }
                if (outcome === "rejected") {
                  throw new Error("first hook failed");
                }
              }),
          },
          {
            hookName: "reply_dispatch",
            pluginId: "next",
            handler: async () =>
              guard("next", async () => {
                await nativeSubagentRuntime.spawn({ requestId: "current", task: "current" });
                nextStarted.resolve();
                if (overlap) {
                  await releaseNext.promise;
                }
                return handledResult;
              }),
          },
        ],
        { logger },
      );
      const work = runner.runReplyDispatch(replyDispatchEvent, { ...replyDispatchCtx }, (invoke) =>
        withNativeSubagentRequest(
          () => ({ spawn, collect: async () => ({ completed: [], pending: [] }) }),
          invoke,
        ),
      );
      try {
        await vi.advanceTimersByTimeAsync(5);
        await nextStarted.promise;
        if (!overlap) {
          await expect(work).resolves.toEqual(handledResult);
        }
        late.resolve();
        await expect(detached).rejects.toThrow("requester-bound");
        expect(spawn.mock.calls).toEqual([
          ...(overlap ? [[{ requestId: "first", task: "active" }]] : []),
          [{ requestId: "current", task: "current" }],
        ]);
        releaseNext.resolve();
        await expect(work).resolves.toEqual(handledResult);
        if (outcome === "timeout") {
          expect(logger.error).toHaveBeenCalledExactlyOnceWith(
            "[hooks] reply_dispatch handler from first failed: timed out after 5ms",
          );
        }
      } finally {
        releaseFirst.resolve();
        releaseNext.resolve();
        await work;
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { kinds: ["acp"], dispatchKind: "agent", eligible: false },
    { kinds: ["acp"], dispatchKind: "acp", eligible: true },
    { kinds: ["acp"], dispatchKind: "unknown-runtime", eligible: true },
    { kinds: undefined, dispatchKind: "agent", eligible: true },
    { kinds: ["acp", "unknown-runtime"], dispatchKind: "agent", eligible: true },
  ])(
    "keeps invocation and presence aligned for $dispatchKind with $kinds eligibility",
    async ({ kinds, dispatchKind, eligible }) => {
      const builder = createTestPluginRegistry();
      const api = builder.createApi(
        createPluginRecord({ id: "scoped-dispatch", origin: "bundled" }),
        { config: {} },
      );
      const handler = vi.fn(() => handledResult);
      const options: PluginHookRegistrationOptions<"reply_dispatch"> = {};
      // JavaScript plugins can supply invalid metadata despite the typed contract.
      Reflect.set(options, "eligibleDispatchKinds", kinds);
      api.on("reply_dispatch", handler, options);
      const runner = createHookRunner(builder.registry);
      const ctx: PluginHookReplyDispatchContext = { ...replyDispatchCtx };
      Reflect.set(ctx, "dispatchKind", dispatchKind);

      expect(runner.hasHooks("reply_dispatch", ctx)).toBe(eligible);
      await expect(runner.runReplyDispatch(replyDispatchEvent, ctx)).resolves.toEqual(
        eligible ? handledResult : undefined,
      );
      expect(handler).toHaveBeenCalledTimes(eligible ? 1 : 0);
    },
  );
});
