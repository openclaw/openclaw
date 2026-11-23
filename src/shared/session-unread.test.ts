// Unread follows visible activity through the real session writers.
import { describe, expect, it } from "vitest";
import { withTempSessionStore } from "../agents/command/session-store.test-support.js";
import {
  initSessionState,
  writeSessionStore,
} from "../auto-reply/reply/test/session.test-support.js";
import { derivePersistedSessionLifecyclePatch } from "../config/sessions/session-run-lifecycle-projection.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { deriveSessionUnread } from "./session-unread.js";

const sessionKey = "agent:main:dashboard:parent";
const sessionId = "parent-session";
const readEntry: SessionEntry = {
  sessionId,
  createdAt: 1,
  updatedAt: 1,
  lastInteractionAt: 5,
  lastActivityAt: 5,
  lastReadAt: 10,
};

function endRun(entry: SessionEntry, controlUiVisible: boolean): SessionEntry {
  const endedAt = Date.now();
  return {
    ...entry,
    ...derivePersistedSessionLifecyclePatch({
      entry,
      event: { ts: endedAt, runId: "run-1", controlUiVisible, data: { phase: "end", endedAt } },
      currentLifecycleGeneration: "test",
    }),
  };
}

describe("deriveSessionUnread", () => {
  it("stays read after a hidden turn and turns unread after a visible reply", () => {
    // A child's sessions_send starts a parent turn that only answers the child: the idle
    // clock moves, the run is not Control UI visible.
    const afterHiddenTurn = { ...readEntry, lastInteractionAt: Date.now() };

    expect(deriveSessionUnread(endRun(afterHiddenTurn, false))).toBe(false);
    expect(deriveSessionUnread(endRun(afterHiddenTurn, true))).toBe(true);
  });

  it("turns unread for an inbound channel message but not for an internal wake", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = { session: { store: storePath } };
      const ctx = { Body: "hello", SessionKey: sessionKey, Provider: "telegram" };

      await writeSessionStore(storePath, { [sessionKey]: readEntry });
      const wake = await initSessionState({ ctx: { ...ctx, InternalTurnSource: "event" }, cfg });
      expect(deriveSessionUnread(wake.sessionEntry)).toBe(false);

      await writeSessionStore(storePath, { [sessionKey]: readEntry });
      const inbound = await initSessionState({ ctx, cfg });
      expect(deriveSessionUnread(inbound.sessionEntry)).toBe(true);
    });
  });
});
