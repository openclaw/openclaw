import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  adoptCronRunSessionMetadata,
  createCronRunContinuationSession,
  type MutableCronSession,
} from "./run-session-state.js";

it("keeps successive exact-run rows limited to their own provider rollover lineage", async () => {
  const baseSessionKey = "agent:main:cron:job";
  const entry: SessionEntry = { sessionId: "previous-run", updatedAt: 1000 };
  const cronSession: MutableCronSession = {
    storePath: "/tmp/sessions.json",
    store: {},
    sessionEntry: entry,
    lifecycleRevision: "previous-revision",
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
    resetBoundaryPending: undefined,
    initialSessionEntry: entry,
  };
  const store: Record<string, SessionEntry> = {};
  for (let run = 0; run < 4; run += 1) {
    const sessionId = `run-${run}`;
    adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: baseSessionKey,
      runMeta: { sessionId },
    });
    cronSession.lifecycleRevision = `revision-${run}`;
    const runSessionKey = `${baseSessionKey}:run:${sessionId}`;
    const continuation = createCronRunContinuationSession({
      cronSession,
      runSessionKey,
      persistSessionEntry: async ({ sessionKey, update }) => {
        store[sessionKey] = update(store[sessionKey]);
      },
    });

    await continuation.initialize();
    expect(store[runSessionKey]?.usageFamilySessionIds).toBeUndefined();
    expect(store[runSessionKey]?.usageFamilyKey).toBe(baseSessionKey);

    for (const phase of ["sync", "seal"] as const) {
      adoptCronRunSessionMetadata({
        entry: cronSession.sessionEntry,
        sessionKey: baseSessionKey,
        runMeta: { sessionId: `${sessionId}-${phase}` },
      });
      await continuation[phase]();
      expect(store[runSessionKey]?.usageFamilySessionIds).toEqual(
        phase === "sync"
          ? [sessionId, `${sessionId}-sync`]
          : [sessionId, `${sessionId}-sync`, `${sessionId}-seal`],
      );
      expect(store[runSessionKey]?.usageFamilyKey).toBe(baseSessionKey);
    }
    expect(cronSession.sessionEntry.usageFamilySessionIds).toHaveLength(1 + (run + 1) * 3);
    expect(cronSession.sessionEntry.usageFamilyKey).toBe(baseSessionKey);
  }
  expect(Object.values(store).map((runEntry) => runEntry.usageFamilySessionIds?.length)).toEqual([
    3, 3, 3, 3,
  ]);
});
