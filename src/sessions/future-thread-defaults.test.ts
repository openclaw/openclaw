import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyFutureThreadModelDefault,
  applyFutureThreadThinkingDefault,
  seedSessionEntryFromFutureThreadDefaults,
} from "./future-thread-defaults.js";

describe("future-thread default history", () => {
  it("records boundary snapshots and seeds older untouched topics from the correct historical default", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:group:-100123": {
        sessionId: "parent-session",
        updatedAt: Date.now() - 5_000,
      },
    };
    const parentSessionKey = "agent:main:telegram:group:-100123";

    applyFutureThreadModelDefault({
      store,
      parentSessionKey,
      selection: {
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      },
      afterThreadId: 84,
    });
    applyFutureThreadThinkingDefault({
      store,
      parentSessionKey,
      level: "medium",
      afterThreadId: 84,
    });
    applyFutureThreadModelDefault({
      store,
      parentSessionKey,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      afterThreadId: 90,
    });
    applyFutureThreadThinkingDefault({
      store,
      parentSessionKey,
      level: "adaptive",
      afterThreadId: 90,
    });

    const parentEntry = store[parentSessionKey];
    expect(parentEntry.futureThreadDefaultsHistory).toHaveLength(2);

    const olderTopicEntry: SessionEntry = {
      sessionId: "older-topic",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: olderTopicEntry,
      parentEntry,
      childThreadId: 89,
    });

    expect(olderTopicEntry.providerOverride).toBe("openai-codex");
    expect(olderTopicEntry.modelOverride).toBe("gpt-5.3-codex");
    expect(olderTopicEntry.thinkingLevel).toBe("medium");

    const newerTopicEntry: SessionEntry = {
      sessionId: "newer-topic",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: newerTopicEntry,
      parentEntry,
      childThreadId: 97,
    });

    expect(newerTopicEntry.providerOverride).toBe("anthropic");
    expect(newerTopicEntry.modelOverride).toBe("claude-sonnet-4-6");
    expect(newerTopicEntry.thinkingLevel).toBe("adaptive");
  });

  it("does not retroactively seed topics that predate every recorded boundary", () => {
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      futureThreadProviderOverride: "anthropic",
      futureThreadModelOverride: "claude-sonnet-4-6",
      futureThreadThinkingLevelOverride: "adaptive",
      futureThreadDefaultsHistory: [
        {
          afterThreadId: 84,
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.3-codex",
          thinkingLevelOverride: "medium",
          updatedAt: Date.now(),
        },
      ],
    };
    const entry: SessionEntry = {
      sessionId: "older-topic",
      updatedAt: Date.now(),
    };

    seedSessionEntryFromFutureThreadDefaults({
      entry,
      parentEntry,
      childThreadId: 81,
    });

    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.thinkingLevel).toBeUndefined();
  });
});
