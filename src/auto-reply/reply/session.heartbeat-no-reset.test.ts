import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
afterEach(async () => {
  await cleanupSessionStateForTest({ stateDir });
});

it("keeps an expired session unchanged for heartbeat and resets on the next user turn", async () => {
  stateDir = tempDirs.make("openclaw-heartbeat-reset-");
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:main:user123";
  const staleTime = Date.now() - 25 * 60 * 60 * 1000;
  const communication = { send: "never", receive: "ask" } as const;
  await replaceSessionEntry(
    { storePath, sessionKey },
    {
      sessionId: "daily-session-id",
      updatedAt: Date.now(),
      systemSent: true,
      sessionStartedAt: staleTime,
      lastInteractionAt: staleTime,
      communication,
    },
  );
  const cfg = {
    agents: { defaults: { workspace: stateDir } },
    session: { store: storePath, reset: { mode: "daily" as const, atHour: 4 } },
  };
  const ctx = {
    From: "user123",
    To: "bot123",
    SessionKey: sessionKey,
    Provider: "quietchat",
    Surface: "quietchat",
    ChatType: "direct",
    CommandAuthorized: true,
  };
  const heartbeat = await initSessionState({
    cfg,
    commandAuthorized: true,
    ctx: finalizeInboundContext({ ...ctx, InternalTurnSource: "heartbeat", Body: "HEARTBEAT_OK" }),
  });
  expect(heartbeat).toMatchObject({
    isNewSession: false,
    resetTriggered: false,
    sessionId: "daily-session-id",
    sessionEntry: { sessionId: "daily-session-id", lastInteractionAt: staleTime },
  });
  expect(loadSessionEntry({ storePath, sessionKey })?.lastInteractionAt).toBe(staleTime);

  const user = await initSessionState({
    cfg,
    commandAuthorized: true,
    ctx: finalizeInboundContext({ ...ctx, Body: "real user message" }),
  });
  expect(user).toMatchObject({ isNewSession: true, sessionId: "daily-session-id" });
  expect(user.sessionEntry.communication).toEqual(communication);
  expect(loadSessionEntry({ storePath, sessionKey })?.communication).toEqual(communication);
});

it.each([false, true])(
  "only user interaction spends snooze (system event: %s)",
  async (isSystemEvent) => {
    stateDir = tempDirs.make("openclaw-heartbeat-snooze-");
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:main:user123";
    const now = Date.now();
    const snooze = { snoozedUntil: now + 3_600_000, snoozedAt: now - 1_000 };
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "snoozed-session",
        updatedAt: now,
        systemSent: true,
        sessionStartedAt: now,
        lastInteractionAt: now - 1_000,
        ...snooze,
      },
    );

    const result = await initSessionState({
      cfg: {
        agents: { defaults: { workspace: stateDir } },
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 5 } },
      },
      commandAuthorized: true,
      ctx: finalizeInboundContext({
        From: "user123",
        To: "bot123",
        SessionKey: sessionKey,
        Provider: "quietchat",
        Surface: "quietchat",
        ChatType: "direct",
        CommandAuthorized: true,
        Body: "test message",
        ...(isSystemEvent ? { InternalTurnSource: "heartbeat" } : {}),
      }),
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("snoozed-session");
    const persisted = loadSessionEntry({ storePath, sessionKey });
    if (!persisted) {
      throw new Error(`Expected persisted session for ${sessionKey}`);
    }
    for (const entry of [result.sessionEntry, persisted]) {
      if (isSystemEvent) {
        expect(entry).toMatchObject(snooze);
        expect(entry.lastInteractionAt).toBe(now - 1_000);
      } else {
        expect(entry.snoozedUntil).toBeUndefined();
        expect(entry.snoozedAt).toBeUndefined();
        expect(entry.lastInteractionAt).toBeGreaterThanOrEqual(now);
      }
    }
  },
);
