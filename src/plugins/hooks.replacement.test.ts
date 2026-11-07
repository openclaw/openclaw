/** Verifies hook dispatch that waits out a plugin reload reruns its admission and context for the replacement. */
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { PluginInstance } from "./plugin-instance.js";
import { attachSessionEndTranscriptSource } from "./session-end-transcript.js";

type MockHook = Parameters<typeof createMockPluginRegistry>[0][number];

// A registry whose hooks a reload swaps in place, as the live global facade does.
function createSwap(
  pluginId: string,
  hook: (instance: PluginInstance, replacement: boolean) => MockHook,
) {
  const previous = new PluginInstance(pluginId);
  const current = new PluginInstance(pluginId);
  const registry = createMockPluginRegistry([hook(previous, false)]);
  const runner = createHookRunner(registry, { catchErrors: true });
  const release = previous.reserveReplacement();
  previous.quiesce();
  return {
    runner,
    async publish() {
      registry.typedHooks = createMockPluginRegistry([hook(current, true)]).typedHooks;
      release();
      await previous.dispose();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hook dispatch across a plugin replacement", () => {
  it("checks binding admission again before the replacement receives an inbound claim", async () => {
    const replacementHandler = vi.fn(() => ({ handled: true }));
    const swap = createSwap("claim-owner", (instance, replacement) => ({
      hookName: "inbound_claim",
      pluginId: "claim-owner",
      handler: instance.wrap(replacement ? replacementHandler : () => ({ handled: true })),
    }));
    let bound = true;
    const prepare = vi.fn(async () => {
      if (!bound) {
        throw new Error("conversation binding changed");
      }
    });
    const ctx = withClaimingHookAdmission({ channelId: "chat" }, { prepare });

    const dispatch = swap.runner.runInboundClaimForPluginOutcome(
      "claim-owner",
      { content: "hello" } as never,
      ctx as never,
    );
    await setImmediate();
    bound = false;
    await swap.publish();

    await expect(dispatch).rejects.toThrow("conversation binding changed");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it("delivers an inbound claim to the replacement when its binding still holds", async () => {
    const replacementHandler = vi.fn(() => ({ handled: true }));
    const swap = createSwap("claim-owner", (instance, replacement) => ({
      hookName: "inbound_claim",
      pluginId: "claim-owner",
      handler: instance.wrap(replacement ? replacementHandler : () => ({ handled: true })),
    }));
    const prepare = vi.fn(async () => undefined);
    const ctx = withClaimingHookAdmission({ channelId: "chat" }, { prepare });

    const dispatch = swap.runner.runInboundClaimForPluginOutcome(
      "claim-owner",
      { content: "hello" } as never,
      ctx as never,
    );
    await setImmediate();
    await swap.publish();

    await expect(dispatch).resolves.toMatchObject({ status: "handled" });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(replacementHandler).toHaveBeenCalledOnce();
  });

  it("gives the replacement a session_end transcript reader bound to its own lifetime", async () => {
    const reads: unknown[] = [];
    const swap = createSwap("transcript-reader", (instance) => ({
      hookName: "session_end",
      pluginId: "transcript-reader",
      conversationAccessAllowed: true,
      handler: instance.wrap(async (_event: unknown, ctx: unknown) => {
        const transcript = (ctx as { endedTranscript: { readTail: (o: unknown) => unknown } })
          .endedTranscript;
        reads.push(await transcript.readTail({ maxMessages: 1, maxBytes: 100 }));
      }),
    }));
    const ctx = { sessionId: "ended" };
    attachSessionEndTranscriptSource(ctx, {
      available: true,
      readTail: async () => ({ messages: ["bye"], totalMessages: 1, truncated: false }),
    });

    const dispatch = swap.runner.runSessionEnd({ sessionId: "ended" } as never, ctx);
    await setImmediate();
    await swap.publish();

    await expect(dispatch).resolves.toBeUndefined();
    expect(reads).toEqual([{ messages: ["bye"], totalMessages: 1, truncated: false }]);
  });

  it("starts no replacement handler after the dispatch timed out waiting for the reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const replacementHandler = vi.fn();
    const swap = createSwap("slow-reload", (instance, replacement) => ({
      hookName: "before_reset",
      pluginId: "slow-reload",
      timeoutMs: 50,
      handler: instance.wrap(replacement ? replacementHandler : vi.fn()),
    }));

    const dispatch = swap.runner.runBeforeReset({ reason: "new" } as never, {} as never);
    await vi.advanceTimersByTimeAsync(50);
    await expect(dispatch).resolves.toBeUndefined();
    await swap.publish();
    await setImmediate();

    expect(replacementHandler).not.toHaveBeenCalled();
  });
});
