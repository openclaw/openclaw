import { describe, expect, it, vi } from "vitest";
import type { LifecycleReactionsConfig } from "../config/types.messages.js";
import {
  clearLifecycleReaction,
  createLifecycleManager,
  createLifecycleState,
  getLifecycleEmoji,
  isLifecycleEnabled,
  transitionLifecycleStage,
  type LifecycleReactionAdapter,
} from "./lifecycle-reactions.js";

function createMockAdapter(): LifecycleReactionAdapter & {
  addedEmojis: string[];
  removedEmojis: string[];
} {
  const adapter: LifecycleReactionAdapter & {
    addedEmojis: string[];
    removedEmojis: string[];
  } = {
    addedEmojis: [],
    removedEmojis: [],
    addReaction: vi.fn(async (emoji: string) => {
      adapter.addedEmojis.push(emoji);
      return true;
    }),
    removeReaction: vi.fn(async (emoji: string) => {
      adapter.removedEmojis.push(emoji);
    }),
    onError: vi.fn(),
  };
  return adapter;
}

describe("getLifecycleEmoji", () => {
  it("returns emoji from config for each stage", () => {
    const config: LifecycleReactionsConfig = {
      received: "👀",
      queued: "🕐",
      processing: "⚙️",
      complete: "✅",
    };

    expect(getLifecycleEmoji(config, "received")).toBe("👀");
    expect(getLifecycleEmoji(config, "queued")).toBe("🕐");
    expect(getLifecycleEmoji(config, "processing")).toBe("⚙️");
    expect(getLifecycleEmoji(config, "complete")).toBe("✅");
  });

  it("returns null for unconfigured stages", () => {
    const config: LifecycleReactionsConfig = {
      received: "👀",
    };

    expect(getLifecycleEmoji(config, "received")).toBe("👀");
    expect(getLifecycleEmoji(config, "queued")).toBeNull();
    expect(getLifecycleEmoji(config, "processing")).toBeNull();
    expect(getLifecycleEmoji(config, "complete")).toBeNull();
  });

  it("falls back to ackReaction for received stage", () => {
    expect(getLifecycleEmoji(undefined, "received", "👀")).toBe("👀");
    expect(getLifecycleEmoji({}, "received", "👀")).toBe("👀");
  });

  it("does not fall back for other stages", () => {
    expect(getLifecycleEmoji(undefined, "processing", "👀")).toBeNull();
    expect(getLifecycleEmoji({}, "complete", "👀")).toBeNull();
  });
});

describe("isLifecycleEnabled", () => {
  it("returns false when only fallback is set (no explicit config)", () => {
    // fallbackAckReaction is only for "received" stage fallback, not enablement
    expect(isLifecycleEnabled(undefined, "👀")).toBe(false);
  });

  it("returns true when any stage is configured", () => {
    expect(isLifecycleEnabled({ complete: "✅" })).toBe(true);
    expect(isLifecycleEnabled({ received: "👀" })).toBe(true);
    expect(isLifecycleEnabled({ processing: "⚙️" })).toBe(true);
  });

  it("returns false when nothing is configured", () => {
    expect(isLifecycleEnabled(undefined)).toBe(false);
    expect(isLifecycleEnabled({})).toBe(false);
  });
});

describe("transitionLifecycleStage", () => {
  it("adds reaction on first transition", async () => {
    const state = createLifecycleState();
    const adapter = createMockAdapter();
    const config: LifecycleReactionsConfig = { received: "👀" };

    const result = await transitionLifecycleStage({
      state,
      config,
      stage: "received",
      adapter,
    });

    expect(result).toBe(true);
    expect(adapter.addReaction).toHaveBeenCalledWith("👀");
    expect(state.currentEmoji).toBe("👀");
    expect(state.currentStage).toBe("received");
  });

  it("swaps reaction when transitioning to new stage with different emoji", async () => {
    const state = createLifecycleState();
    state.currentEmoji = "👀";
    state.currentStage = "received";

    const adapter = createMockAdapter();
    const config: LifecycleReactionsConfig = { received: "👀", processing: "⚙️" };

    await transitionLifecycleStage({
      state,
      config,
      stage: "processing",
      adapter,
    });

    expect(adapter.removeReaction).toHaveBeenCalledWith("👀");
    expect(adapter.addReaction).toHaveBeenCalledWith("⚙️");
    expect(state.currentEmoji).toBe("⚙️");
    expect(state.currentStage).toBe("processing");
  });

  it("does not change reaction when emoji is the same", async () => {
    const state = createLifecycleState();
    state.currentEmoji = "👀";
    state.currentStage = "received";

    const adapter = createMockAdapter();
    const config: LifecycleReactionsConfig = { received: "👀", queued: "👀" };

    await transitionLifecycleStage({
      state,
      config,
      stage: "queued",
      adapter,
    });

    expect(adapter.removeReaction).not.toHaveBeenCalled();
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(state.currentEmoji).toBe("👀");
    expect(state.currentStage).toBe("queued");
  });

  it("removes reaction when transitioning to stage with no emoji", async () => {
    const state = createLifecycleState();
    state.currentEmoji = "👀";
    state.currentStage = "received";

    const adapter = createMockAdapter();
    const config: LifecycleReactionsConfig = { received: "👀" };

    await transitionLifecycleStage({
      state,
      config,
      stage: "complete",
      adapter,
    });

    expect(adapter.removeReaction).toHaveBeenCalledWith("👀");
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(state.currentEmoji).toBeNull();
    expect(state.currentStage).toBe("complete");
  });
});

describe("clearLifecycleReaction", () => {
  it("removes current emoji and clears state", async () => {
    const state = createLifecycleState();
    state.currentEmoji = "👀";
    state.currentStage = "received";

    const adapter = createMockAdapter();

    await clearLifecycleReaction({ state, adapter });

    expect(adapter.removeReaction).toHaveBeenCalledWith("👀");
    expect(state.currentEmoji).toBeNull();
    expect(state.currentStage).toBeNull();
  });

  it("does nothing when no emoji is set", async () => {
    const state = createLifecycleState();
    const adapter = createMockAdapter();

    await clearLifecycleReaction({ state, adapter });

    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });
});

describe("createLifecycleManager", () => {
  it("provides convenience methods for stage transitions", async () => {
    const adapter = createMockAdapter();
    const config: LifecycleReactionsConfig = {
      received: "👀",
      processing: "⚙️",
      complete: "✅",
    };

    const manager = createLifecycleManager({ config, adapter });

    await manager.received();
    expect(manager.getCurrentStage()).toBe("received");
    expect(manager.getCurrentEmoji()).toBe("👀");

    await manager.processing();
    expect(manager.getCurrentStage()).toBe("processing");
    expect(manager.getCurrentEmoji()).toBe("⚙️");

    await manager.complete();
    expect(manager.getCurrentStage()).toBe("complete");
    expect(manager.getCurrentEmoji()).toBe("✅");
  });
});
