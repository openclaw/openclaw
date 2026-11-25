import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const inboundClaimEvent = {
  content: "who are you",
  channel: "guildchat",
  accountId: "default",
  conversationId: "channel:1",
  isGroup: true,
};

const inboundClaimCtx = {
  channelId: "guildchat",
  accountId: "default",
  conversationId: "channel:1",
};

describe("inbound_claim hook runner", () => {
  const runTargeted = (
    runner: ReturnType<typeof createHookRunnerWithRegistry>["runner"],
    pluginId = "test-plugin",
  ) => runner.runInboundClaimForPluginOutcome(pluginId, inboundClaimEvent, inboundClaimCtx);

  it.each([undefined, "beta-plugin"])(
    "selects the first eligible claimant (target=%s)",
    async (target) => {
      const first = vi.fn().mockResolvedValue({ handled: true });
      const second = vi.fn().mockResolvedValue({ handled: true });
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "inbound_claim",
          handler: first,
          pluginId: target ? "alpha-plugin" : undefined,
        },
        { hookName: "inbound_claim", handler: second, pluginId: target },
      ]);

      const result = target
        ? await runner.runInboundClaimForPlugin(target, inboundClaimEvent, inboundClaimCtx)
        : await runner.runInboundClaim(inboundClaimEvent, inboundClaimCtx);

      expect(result).toEqual({ handled: true });
      expect(first).toHaveBeenCalledTimes(target ? 0 : 1);
      expect(second).toHaveBeenCalledTimes(target ? 1 : 0);
    },
  );

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "inbound_claim", handler: failing },
        { hookName: "inbound_claim", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runInboundClaim(inboundClaimEvent, inboundClaimCtx);

    expect(result).toEqual({ handled: true });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "[hooks] inbound_claim handler from test-plugin failed: boom",
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reports absent targeted hooks (plugin loaded=%s)", async (loaded) => {
    const { registry, runner } = createHookRunnerWithRegistry([]);
    if (!loaded) {
      registry.plugins = [];
    }
    expect(await runTargeted(runner, loaded ? "test-plugin" : "missing-plugin")).toEqual({
      status: loaded ? "no_handler" : "missing_plugin",
    });
  });

  it("reports targeted per-hook registration timeouts as handler errors", async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const slow = vi.fn(() => new Promise(() => {}));
      const { registry, runner } = createHookRunnerWithRegistry(
        [{ hookName: "inbound_claim", handler: slow }],
        { logger },
      );
      expectDefined(registry.typedHooks[0], "registry.typedHooks[0] test invariant").timeoutMs = 5;

      const run = runTargeted(runner);
      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toEqual({ status: "error", error: "timed out after 5ms" });
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "[hooks] inbound_claim handler from test-plugin failed: timed out after 5ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
