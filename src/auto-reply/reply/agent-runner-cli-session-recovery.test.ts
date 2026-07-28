import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createCliSessionRecoveryCallbacks } from "./agent-runner-cli-session-recovery.js";

describe("createCliSessionRecoveryCallbacks", () => {
  const fixture = useTempSessionsFixture("cli-session-recovery-");

  function createState() {
    const sessionKey = "main";
    const sessionId = "stale-cli-session";
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId } },
      cliSessionIds: { "claude-cli": sessionId },
      claudeCliSessionId: sessionId,
    };
    return { sessionKey, sessionId, entry, sessionStore: { [sessionKey]: entry } };
  }

  it("clears a reused Claude CLI binding after failover", async () => {
    const state = createState();
    await replaceSessionEntry(
      { sessionKey: state.sessionKey, storePath: fixture.storePath() },
      structuredClone(state.entry),
    );
    const callbacks = createCliSessionRecoveryCallbacks({
      provider: "claude-cli",
      binding: { sessionId: state.sessionId },
      sessionKey: state.sessionKey,
      sessionStore: state.sessionStore,
      storePath: fixture.storePath(),
      getActiveSessionEntry: () => state.entry,
      hasCommittedMedia: () => false,
    });

    await callbacks.onErrorBeforeLifecycle?.(
      new FailoverError("Not logged in", { reason: "auth", provider: "claude-cli" }),
    );

    expect(state.entry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey: state.sessionKey, storePath: fixture.storePath() })
        ?.cliSessionBindings?.["claude-cli"],
    ).toBeUndefined();
  });

  it("preserves a replacement binding installed after callback creation", async () => {
    const state = createState();
    await replaceSessionEntry(
      { sessionKey: state.sessionKey, storePath: fixture.storePath() },
      structuredClone(state.entry),
    );
    const callbacks = createCliSessionRecoveryCallbacks({
      provider: "claude-cli",
      binding: { sessionId: state.sessionId },
      sessionKey: state.sessionKey,
      sessionStore: state.sessionStore,
      storePath: fixture.storePath(),
      getActiveSessionEntry: () => state.entry,
      hasCommittedMedia: () => false,
    });
    await replaceSessionEntry(
      { sessionKey: state.sessionKey, storePath: fixture.storePath() },
      {
        ...state.entry,
        updatedAt: 2,
        cliSessionBindings: { "claude-cli": { sessionId: "replacement-cli-session" } },
      },
    );

    await expect(
      callbacks.onBeforeFreshCliSessionRetry?.({
        provider: "claude-cli",
        reason: "session_expired",
        sessionId: state.sessionId,
      }),
    ).resolves.toBe(false);
    expect(state.entry.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(state.sessionId);
  });

  it("blocks media replay but still clears the expired binding", async () => {
    const state = createState();
    await replaceSessionEntry(
      { sessionKey: state.sessionKey, storePath: fixture.storePath() },
      structuredClone(state.entry),
    );
    const callbacks = createCliSessionRecoveryCallbacks({
      provider: "claude-cli",
      binding: { sessionId: state.sessionId },
      sessionKey: state.sessionKey,
      sessionStore: state.sessionStore,
      storePath: fixture.storePath(),
      getActiveSessionEntry: () => state.entry,
      hasCommittedMedia: () => true,
    });

    await expect(
      callbacks.onBeforeFreshCliSessionRetry?.({
        provider: "claude-cli",
        reason: "session_expired",
        sessionId: state.sessionId,
      }),
    ).resolves.toBe(false);
    expect(state.entry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey: state.sessionKey, storePath: fixture.storePath() })
        ?.cliSessionBindings?.["claude-cli"],
    ).toBeUndefined();
  });

  it("leaves fork bindings to their owning lifecycle on terminal errors", () => {
    const state = createState();
    const callbacks = createCliSessionRecoveryCallbacks({
      provider: "claude-cli",
      binding: { sessionId: state.sessionId, forkNextResume: true },
      sessionKey: state.sessionKey,
      sessionStore: state.sessionStore,
      storePath: fixture.storePath(),
      getActiveSessionEntry: () => state.entry,
      hasCommittedMedia: () => false,
    });

    expect(callbacks.onErrorBeforeLifecycle).toBeUndefined();
    expect(callbacks.onBeforeFreshCliSessionRetry).toEqual(expect.any(Function));
  });
});
