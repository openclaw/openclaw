import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  adoptCronRunSessionMetadata,
  createCronRunContinuationSession,
  type MutableCronSession,
} from "./run-session-state.js";

it("keeps successive exact-run rows limited to their own provider rollover lineage", async () => {
  const baseSessionKey = "agent:main:cron:job";
  const entry: SessionEntry = { sessionId: "previous-run", updatedAt: 1000 };
  const cronSession: MutableCronSession = {
    storePath: path.join(sessionDirs.make(), "sessions.json"),
    store: {},
    sessionEntry: entry,
    lifecycleRevision: "previous-revision",
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
    resetBoundaryPending: undefined,
    initialSessionEntry: entry,
  };
  const familySizes: Array<number | undefined> = [];
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
    });

    await continuation.initialize();
    let persisted = loadSessionEntry({
      storePath: cronSession.storePath,
      sessionKey: runSessionKey,
    });
    expect(persisted?.usageFamilySessionIds).toBeUndefined();
    expect(persisted?.usageFamilyKey).toBe(baseSessionKey);

    for (const phase of ["sync", "seal"] as const) {
      adoptCronRunSessionMetadata({
        entry: cronSession.sessionEntry,
        sessionKey: baseSessionKey,
        runMeta: { sessionId: `${sessionId}-${phase}` },
      });
      await continuation[phase]();
      persisted = loadSessionEntry({ storePath: cronSession.storePath, sessionKey: runSessionKey });
      expect(persisted?.usageFamilySessionIds).toEqual(
        phase === "sync"
          ? [sessionId, `${sessionId}-sync`]
          : [sessionId, `${sessionId}-sync`, `${sessionId}-seal`],
      );
      expect(persisted?.usageFamilyKey).toBe(baseSessionKey);
    }
    familySizes.push(persisted?.usageFamilySessionIds?.length);
    expect(cronSession.sessionEntry.usageFamilySessionIds).toHaveLength(1 + (run + 1) * 3);
    expect(cronSession.sessionEntry.usageFamilyKey).toBe(baseSessionKey);
  }
  expect(familySizes).toEqual([3, 3, 3, 3]);
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-lineage-");
