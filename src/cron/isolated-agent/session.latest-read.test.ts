// Behavior tests for the cron lifecycle-guard session read.
// loadCronSessionEntryLatest must observe the latest persisted row through the
// SQLite accessor, because cron admission guards fence on it (see run.ts
// assertAllowed). Seeding and re-seeding go through replaceSessionEntry so the
// read is proven against the same canonical store the cron persist path writes.
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { loadCronSessionEntryLatest } from "./session.js";

const SESSION_KEY = "agent:main:cron:job-1";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-latest-");

function createStorePath(): string {
  return path.join(sessionDirs.make(), "sessions.json");
}

it("reads the latest persisted row after it is replaced", async () => {
  const storePath = createStorePath();
  await replaceSessionEntry(
    { sessionKey: SESSION_KEY, storePath },
    { sessionId: "sess-one", updatedAt: 1000 },
  );
  expect(loadSessionEntry({ sessionKey: SESSION_KEY, storePath })?.sessionId).toBe("sess-one");

  // Re-seed the row out-of-band; the lifecycle-guard read must observe it.
  await replaceSessionEntry(
    { sessionKey: SESSION_KEY, storePath },
    { sessionId: "sess-two", updatedAt: 2000 },
  );
  expect(loadCronSessionEntryLatest(storePath, SESSION_KEY)?.sessionId).toBe("sess-two");
});

it("returns undefined for a session key without a persisted row", async () => {
  const storePath = createStorePath();
  await replaceSessionEntry(
    { sessionKey: SESSION_KEY, storePath },
    { sessionId: "sess-one", updatedAt: 1000 },
  );
  expect(loadCronSessionEntryLatest(storePath, "agent:main:cron:missing")).toBeUndefined();
});
