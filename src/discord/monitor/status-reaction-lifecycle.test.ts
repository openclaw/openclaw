import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  createDiscordStatusReactionLifecycle,
  resolveDiscordStatusReactionProjection,
} from "./status-reaction-lifecycle.js";

describe("status-reaction-lifecycle", () => {
  it("keeps waiting-fresh and waiting-backlog mutually exclusive per message", async () => {
    const setReaction = vi.fn(async (_emoji: string) => {});
    const removeReaction = vi.fn(async (_emoji: string) => {});
    const lifecycle = createDiscordStatusReactionLifecycle({
      enabled: true,
      messageId: "m1",
      adapter: { setReaction, removeReaction },
      projection: resolveDiscordStatusReactionProjection(undefined, "👀"),
    });

    await lifecycle.enterWaiting(true);
    await lifecycle.enterActive();
    await lifecycle.complete(true);

    const emojis = setReaction.mock.calls.map((call) => call[0]);
    expect(emojis).toContain("⏳");
    expect(emojis).not.toContain("👀");
  });

  it("keeps waiting when active interruption fails", async () => {
    let activeFailed = false;
    const setReaction = vi.fn(async (emoji: string) => {
      if (emoji === "🤔" && !activeFailed) {
        activeFailed = true;
        throw new Error("active failed");
      }
    });
    const onError = vi.fn();
    const lifecycle = createDiscordStatusReactionLifecycle({
      enabled: true,
      messageId: "m2",
      adapter: { setReaction },
      projection: resolveDiscordStatusReactionProjection(undefined, "👀"),
      onError,
    });

    await lifecycle.enterWaiting(false);
    await lifecycle.enterActive();
    await lifecycle.complete(true);

    const emojis = setReaction.mock.calls.map((call) => call[0]);
    expect(emojis).toEqual(["👀", "🤔"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting until an active interruption is requested", async () => {
    const setReaction = vi.fn(async (_emoji: string) => {});
    const lifecycle = createDiscordStatusReactionLifecycle({
      enabled: true,
      messageId: "m3",
      adapter: { setReaction },
      projection: resolveDiscordStatusReactionProjection(undefined, "👀"),
    });

    await lifecycle.enterWaiting(true);
    await lifecycle.complete(true);

    expect(setReaction.mock.calls.map((call) => call[0])).toEqual(["⏳"]);
  });

  it("records failed transition when active update fails", async () => {
    __testing.resetTraceEntriesForTests();
    const lifecycle = createDiscordStatusReactionLifecycle({
      enabled: true,
      messageId: "m4",
      adapter: {
        setReaction: async (emoji: string) => {
          if (emoji === "🤔") {
            throw new Error("boom");
          }
        },
      },
      projection: resolveDiscordStatusReactionProjection(undefined, "👀"),
    });

    await lifecycle.enterWaiting(false);
    await lifecycle.enterActive();

    const failed = __testing
      .getTraceEntriesForTests()
      .filter((entry) => entry.messageId === "m4" && entry.stage === "failed")
      .map((entry) => entry.state);
    expect(failed).toContain("active");
  });
});

it("requires a completed active transition before terminal transition", async () => {
  __testing.resetTraceEntriesForTests();
  const releaseActiveRef: { current?: () => void } = {};
  const setReaction = vi.fn((emoji: string) => {
    if (emoji === "🤔") {
      return new Promise<void>((resolve) => {
        releaseActiveRef.current = resolve;
      });
    }
    return Promise.resolve();
  });
  const lifecycle = createDiscordStatusReactionLifecycle({
    enabled: true,
    messageId: "m5",
    adapter: { setReaction },
    projection: resolveDiscordStatusReactionProjection(undefined, "👀"),
  });

  await lifecycle.enterWaiting(false);
  const activePromise = lifecycle.enterActive();
  await Promise.resolve();
  expect(setReaction.mock.calls.map((call) => call[0])).toEqual(["👀", "🤔"]);

  const blockedComplete = lifecycle.complete(true);
  await Promise.resolve();
  expect(setReaction.mock.calls.map((call) => call[0])).toEqual(["👀", "🤔"]);

  releaseActiveRef.current?.();
  await activePromise;
  await blockedComplete;
  await lifecycle.complete(true);

  expect(setReaction.mock.calls.map((call) => call[0])).toEqual(["👀", "🤔", "✅"]);
});
