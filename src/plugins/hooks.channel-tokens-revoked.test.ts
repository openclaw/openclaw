import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { PluginInstance } from "./plugin-instance.js";

const event = {
  eventId: "EvREVOCATION1",
  eventTime: 1_700_000_000,
  appId: "A123",
  workspaceId: "T123",
  oauthUserIds: ["U123"],
};
const context = { channelId: "slack", accountId: "default" };

describe("channel_tokens_revoked consumer acceptance", () => {
  const required = { requiredConsumerPluginIds: ["required"] };

  it("refuses a missing required plugin before invoking unrelated handlers", async () => {
    const unrelated = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "channel_tokens_revoked", pluginId: "unrelated", handler: unrelated },
    ]);
    expect(() => runner.assertChannelTokensRevokedConsumersReady(required)).toThrow(
      "required consumer is unavailable",
    );
    await expect(runner.runChannelTokensRevoked(event, context, required)).rejects.toThrow(
      "required consumer is unavailable",
    );
    expect(unrelated).not.toHaveBeenCalled();
  });

  it.each(["disabled", "error"] as const)(
    "refuses a %s plugin with a stale handler",
    async (status) => {
      const handler = vi.fn();
      const { runner, registry } = createHookRunnerWithRegistry([
        { hookName: "channel_tokens_revoked", pluginId: "required", handler },
      ]);
      const plugin = registry.plugins[0];
      if (!plugin) {
        throw new Error("Expected the required plugin record");
      }
      plugin.status = status;
      await expect(runner.runChannelTokensRevoked(event, context, required)).rejects.toThrow(
        "required consumer is unavailable",
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("refuses a disabled record even if its status still says loaded", async () => {
    const { runner, registry } = createHookRunnerWithRegistry([
      { hookName: "channel_tokens_revoked", pluginId: "required", handler: vi.fn() },
    ]);
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("Expected the required plugin record");
    }
    plugin.enabled = false;
    expect(() => runner.assertChannelTokensRevokedConsumersReady(required)).toThrow(
      "required consumer is unavailable",
    );
  });

  it("refuses a retired callable even if its plugin record and registration remain", async () => {
    const instance = new PluginInstance("required");
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "channel_tokens_revoked", pluginId: "required", handler: instance.wrap(handler) },
    ]);
    expect(() => runner.assertChannelTokensRevokedConsumersReady(required)).not.toThrow();
    await instance.dispose();
    expect(() => runner.assertChannelTokensRevokedConsumersReady(required)).toThrow(
      "required consumer is unavailable",
    );
    await expect(runner.runChannelTokensRevoked(event, context, required)).rejects.toThrow(
      "required consumer is unavailable",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks and invokes the same hook snapshot", async () => {
    const handler = vi.fn();
    const { runner, registry } = createHookRunnerWithRegistry([
      { hookName: "channel_tokens_revoked", pluginId: "required", handler },
    ]);
    const hooks = registry.typedHooks;
    const lookup = vi.fn().mockReturnValueOnce(hooks).mockReturnValue([]);
    Object.defineProperty(registry, "typedHooks", { get: lookup });
    await runner.runChannelTokensRevoked(event, context, required);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(
    [Array(9).fill("required"), [""], ["a".repeat(129)], [" required"]].map((ids) => ({ ids })),
  )("rejects an invalid or unbounded required policy", async ({ ids }) => {
    const { runner } = createHookRunnerWithRegistry([]);
    await expect(
      runner.runChannelTokensRevoked(event, context, { requiredConsumerPluginIds: ids }),
    ).rejects.toThrow("required consumer policy is invalid");
  });

  it("preserves stock behavior without a consumer", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    await expect(runner.runChannelTokensRevoked(event, context)).resolves.toBeUndefined();
  });

  it("projects and freezes metadata/context without leaking extra caller fields", async () => {
    const seen: unknown[] = [];
    const first = vi.fn((value: unknown, ctx: unknown) => {
      seen.push(value, ctx);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(Object.isFrozen(Reflect.get(value as object, "oauthUserIds"))).toBe(true);
      expect(Reflect.set(value as object, "appId", "AOTHER")).toBe(false);
    });
    const second = vi.fn((value: unknown) => expect(value).toEqual(event));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "channel_tokens_revoked", handler: first },
      { hookName: "channel_tokens_revoked", handler: second },
    ]);
    const callerEvent = {
      ...event,
      privateText: "synthetic-private-message",
      token: "synthetic-secret",
    };
    const callerContext = { ...context, privateText: "synthetic-private-context" };
    await runner.runChannelTokensRevoked(callerEvent, callerContext);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([event, context]);
    expect(seen[0]).not.toBe(event);
  });

  it("settles every consumer and propagates failure despite fail-open overrides", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const accepted = vi.fn(async () => {
      await gate;
    });
    const refused = vi.fn(async () => {
      throw new SyntaxError("synthetic-secret");
    });
    const log = { error: vi.fn(), warn: vi.fn() };
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "channel_tokens_revoked", handler: refused },
        { hookName: "channel_tokens_revoked", handler: accepted },
      ],
      {
        catchErrors: true,
        failurePolicyByHook: { channel_tokens_revoked: "fail-open" },
        logger: log,
      },
    );
    let settled = false;
    const result = runner.runChannelTokensRevoked(event, context);
    const rejection = expect(result).rejects.toThrow("consumer acceptance failed");
    result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(accepted).toHaveBeenCalledTimes(1);
    finish();
    await rejection;
    expect(log.error).not.toHaveBeenCalled();
    await expect(result).rejects.not.toHaveProperty("cause");
  });

  it("rejects on bounded timeout and allows idempotent retry with the original identity", async () => {
    vi.useFakeTimers();
    try {
      const accepted = new Set<string>();
      let finish: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let first = true;
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "channel_tokens_revoked",
          handler: async () => {
            if (first) {
              first = false;
              await gate;
            }
            accepted.add(event.eventId);
          },
          timeoutMs: 10,
        },
      ]);
      const attempt = runner.runChannelTokensRevoked(event, context);
      const rejection = expect(attempt).rejects.toThrow("consumer acceptance failed");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      await runner.runChannelTokensRevoked(event, context);
      finish();
      await Promise.resolve();
      expect([...accepted]).toEqual([event.eventId]);
    } finally {
      vi.useRealTimers();
    }
  });
});
