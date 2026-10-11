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

it("keeps an expired session unchanged for automation and resets on the next user turn", async () => {
  stateDir = tempDirs.make("openclaw-automation-reset-");
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:main:user123";
  const staleTime = Date.now() - 25 * 60 * 60 * 1000;
  const snooze = { snoozedUntil: Date.now() + 3_600_000, snoozedAt: staleTime };
  const communication = { send: "never", receive: "ask" } as const;
  await replaceSessionEntry(
    { storePath, sessionKey },
    {
      sessionId: "daily-session-id",
      sidebarRoot: true,
      updatedAt: Date.now(),
      systemSent: true,
      sessionStartedAt: staleTime,
      lastInteractionAt: staleTime,
      ...snooze,
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
  const automation = await initSessionState({
    cfg,
    commandAuthorized: true,
    ctx: finalizeInboundContext({
      ...ctx,
      InternalTurnSource: "cron",
      Body: "Run the scheduled check.",
    }),
  });
  expect(automation).toMatchObject({
    isNewSession: false,
    resetTriggered: false,
    sessionId: "daily-session-id",
    sessionEntry: { sessionId: "daily-session-id", lastInteractionAt: staleTime, ...snooze },
  });
  expect(loadSessionEntry({ storePath, sessionKey })?.lastInteractionAt).toBe(staleTime);
  expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(snooze);

  const user = await initSessionState({
    cfg,
    commandAuthorized: true,
    ctx: finalizeInboundContext({ ...ctx, Body: "real user message" }),
  });
  expect(user).toMatchObject({
    isNewSession: true,
    sessionId: "daily-session-id",
    sessionEntry: { sidebarRoot: true, snoozedUntil: undefined, snoozedAt: undefined },
  });
  const persisted = loadSessionEntry({ storePath, sessionKey });
  expect(persisted?.sidebarRoot).toBe(true);
  expect(persisted?.snoozedUntil).toBeUndefined();
  expect(persisted?.snoozedAt).toBeUndefined();
  expect(user.sessionEntry.communication).toEqual(communication);
  expect(loadSessionEntry({ storePath, sessionKey })?.communication).toEqual(communication);
});
