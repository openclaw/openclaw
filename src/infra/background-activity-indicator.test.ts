// Core engine tests for the background-activity indicator: pure diffing
// logic against faked sources/channel target (the real production sources
// are proven separately in background-activity-sources.test.ts against the
// real registries), plus a coexistence proof against the real turn-bound
// `TypingController` to pin that the two never share state or cross-invoke.
import { describe, expect, it, vi } from "vitest";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { ChannelHeartbeatAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createBackgroundActivityIndicator,
  type BackgroundActivitySources,
} from "./background-activity-indicator.js";

function createMutableSources() {
  let subagent: string[] = [];
  let cron: string[] = [];
  const sources: BackgroundActivitySources = {
    listArmedSubagentWaitSessionKeys: () => subagent,
    listArmedCronWakeSessionKeys: () => cron,
  };
  return {
    sources,
    setSubagent: (keys: string[]) => {
      subagent = keys;
    },
    setCron: (keys: string[]) => {
      cron = keys;
    },
  };
}

function createFakePlugin() {
  const sendTyping = vi.fn(async (_target: { to: string; accountId?: string | null }) => undefined);
  const clearTyping = vi.fn(async () => undefined);
  return { plugin: { heartbeat: { sendTyping, clearTyping } }, sendTyping, clearTyping };
}

describe("createBackgroundActivityIndicator", () => {
  it("activates a session's channel indicator once an armed subagent wait is discovered", async () => {
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s2"]);
    const { plugin, sendTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s2" ? { channel: "discord", to: "chan-2" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s2")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("activates a session's channel indicator once an armed cron wake is discovered", async () => {
    const { sources, setCron } = createMutableSources();
    setCron(["agent:main:s3"]);
    const { plugin, sendTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s3" ? { channel: "discord", to: "chan-3" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s3")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("deactivates a session once neither source report it armed anymore", async () => {
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s4"]);
    const { plugin, sendTyping, clearTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s4" ? { channel: "discord", to: "chan-4" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });

    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s4")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    setSubagent([]);
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s4")).toBe(false);
    expect(clearTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("stops every active session when the gateway instance becomes unavailable", async () => {
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s5"]);
    const { plugin, clearTyping } = createFakePlugin();
    let available = true;
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => available,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: () => ({ channel: "discord", to: "chan-5" }),
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s5")).toBe(true);

    available = false;
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s5")).toBe(false);
    expect(clearTyping).toHaveBeenCalledTimes(1);
  });

  it("never activates or interferes with the turn-bound TypingController's seal-after-completion guarantee", async () => {
    // The turn-bound controller: start it, finish its turn, and let it seal --
    // exactly the "late/stray event after completion" guarantee it exists for.
    const turnOnReplyStart = vi.fn(async () => undefined);
    const turnOnCleanup = vi.fn(() => undefined);
    const turnBound = createTypingController({
      onReplyStart: turnOnReplyStart,
      onCleanup: turnOnCleanup,
      typingIntervalSeconds: 0,
    });
    await turnBound.startTypingLoop();
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    turnBound.markRunComplete();
    turnBound.markDispatchIdle();
    expect(turnOnCleanup).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);

    // A late/stray event after completion must still never restart it.
    await turnBound.startTypingOnText("late stray text");
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);

    // Independently, the background indicator activates and deactivates its
    // own instance for the same conceptual destination -- proving the two
    // mechanisms share no state and never call into one another.
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s6"]);
    const { plugin, sendTyping, clearTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: () => ({ channel: "discord", to: "chan-6" }),
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(sendTyping).toHaveBeenCalledTimes(1);
    setSubagent([]);
    await indicator.tick();
    expect(clearTyping).toHaveBeenCalledTimes(1);

    // The turn-bound controller's sealed state is untouched by any of that.
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    expect(turnOnCleanup).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);
  });

  it("stops sending as soon as typing is switched off for a session that stays armed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { sources, setSubagent } = createMutableSources();
      setSubagent(["agent:main:s7"]);
      const { plugin, sendTyping, clearTyping } = createFakePlugin();
      let typingEnabled = true;
      const indicator = createBackgroundActivityIndicator({
        isAvailable: () => true,
        sources,
        target: {
          getConfig: () => ({}) as OpenClawConfig,
          resolveDelivery: () => ({ channel: "discord", to: "chan-7" }),
          resolveChannelPlugin: () => plugin,
          isTypingEnabled: () => typingEnabled,
          typingIntervalSeconds: () => 1,
        },
      });
      await indicator.tick();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendTyping).toHaveBeenCalledTimes(2);

      // No poll in between: the keepalive itself must notice the opt-out.
      typingEnabled = false;
      await vi.advanceTimersByTimeAsync(3000);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      expect(clearTyping).toHaveBeenCalledTimes(1);
      expect(indicator.isActiveForSession("agent:main:s7")).toBe(false);
      indicator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never keeps typing into a route the session has moved away from", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { sources, setCron } = createMutableSources();
      setCron(["agent:main:s8"]);
      const { plugin, sendTyping } = createFakePlugin();
      let delivery = { channel: "discord", to: "chan-old", accountId: "work" };
      const indicator = createBackgroundActivityIndicator({
        isAvailable: () => true,
        sources,
        target: {
          getConfig: () => ({}) as OpenClawConfig,
          resolveDelivery: () => delivery,
          resolveChannelPlugin: () => plugin,
          typingIntervalSeconds: () => 1,
        },
      });
      await indicator.tick();
      const sentTo = () => sendTyping.mock.calls.map(([target]) => [target.to, target.accountId]);
      expect(sentTo()).toEqual([["chan-old", "work"]]);

      delivery = { channel: "discord", to: "chan-new", accountId: "personal" };
      await vi.advanceTimersByTimeAsync(3000);
      expect(sentTo()).toEqual([["chan-old", "work"]]);
      expect(indicator.isActiveForSession("agent:main:s8")).toBe(false);

      // The next poll re-activates the still-armed session against its current route.
      await indicator.tick();
      expect(sentTo()).toEqual([
        ["chan-old", "work"],
        ["chan-new", "personal"],
      ]);
      indicator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drives a channel's guarded typing with a live authorization check", async () => {
    type GuardedTarget = Parameters<NonNullable<ChannelHeartbeatAdapter["sendTypingGuarded"]>>[0];
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s9"]);
    const guarded: GuardedTarget[] = [];
    const sendTyping = vi.fn(async () => undefined);
    const plugin = {
      heartbeat: {
        sendTyping,
        sendTypingGuarded: async (target: GuardedTarget) => {
          guarded.push(target);
        },
      },
    };
    let available = true;
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => available,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: () => ({ channel: "telegram", to: "-1009" }),
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(sendTyping).not.toHaveBeenCalled();
    expect(guarded.map(({ to }) => to)).toEqual(["-1009"]);
    const [target] = guarded;
    expect(() => target?.assertPlatformSendAuthorized()).not.toThrow();

    // A channel that waited on its transport must be refused once the instance retires.
    available = false;
    expect(() => target?.assertPlatformSendAuthorized()).toThrow(/no longer current/);
    expect(target?.signal.aborted).toBe(true);
    expect(indicator.isActiveForSession("agent:main:s9")).toBe(false);
  });

  it.each(["sources", "delivery", "plugin"] as const)(
    "registers nothing when stopped while a pass is still awaiting its %s",
    async (stage) => {
      const gate = createDeferredCore();
      const waitAt = async (at: typeof stage) => {
        if (at === stage) {
          await gate.promise;
        }
      };
      const { plugin, sendTyping } = createFakePlugin();
      const indicator = createBackgroundActivityIndicator({
        isAvailable: () => true,
        sources: {
          listArmedSubagentWaitSessionKeys: async () => {
            await waitAt("sources");
            return ["agent:main:s10"];
          },
          listArmedCronWakeSessionKeys: () => [],
        },
        target: {
          getConfig: () => ({}) as OpenClawConfig,
          resolveDelivery: async () => {
            await waitAt("delivery");
            return { channel: "discord", to: "chan-10" };
          },
          resolveChannelPlugin: async () => {
            await waitAt("plugin");
            return plugin;
          },
        },
      });
      const pass = indicator.tick();
      // Let the pass run up to the gated await before the instance retires.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      indicator.stop();
      gate.resolve();
      await pass;

      expect(indicator.isActiveForSession("agent:main:s10")).toBe(false);
      expect(sendTyping).not.toHaveBeenCalled();
    },
  );
});
