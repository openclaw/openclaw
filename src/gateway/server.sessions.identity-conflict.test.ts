// Identity-conflict rejections across session mutations: every path that finds the
// named identity gone must say whether the key's new occupant continues it.
import { afterEach, expect, test } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  {
    name: "rollover recorded as the previous session",
    entry: () => sessionStoreEntry("sess-successor", { previousSessionId: "sess-stale" }),
    expectedDetails: { code: "SESSION_CHANGED", successorSessionId: "sess-successor" },
  },
  {
    name: "second rollover still resolving through the usage family",
    entry: () =>
      sessionStoreEntry("sess-successor", {
        previousSessionId: "sess-middle",
        usageFamilySessionIds: ["sess-stale", "sess-middle"],
      }),
    expectedDetails: { code: "SESSION_CHANGED", successorSessionId: "sess-successor" },
  },
  {
    name: "unrelated session recreated under the same key",
    entry: () => sessionStoreEntry("sess-unrelated"),
    expectedDetails: { code: "SESSION_CHANGED" },
  },
])(
  "sessions.delete names a successor only when lineage proves it: $name",
  async ({ entry, expectedDetails }) => {
    await createSessionStoreDir();
    const sessionKey = "agent:main:subagent:worker";
    await writeSessionStore({ entries: { [sessionKey]: entry() } });

    const deleted = await directSessionReq("sessions.delete", {
      key: sessionKey,
      expectedSessionId: "sess-stale",
    });

    expect(deleted.ok).toBe(false);
    // A recreated session records no lineage, so it is reported as a replacement: naming
    // it as a successor would invite a retry onto a session the caller never picked.
    expect((deleted.error as { details?: unknown } | undefined)?.details).toEqual(expectedDetails);
  },
);

test.each([
  {
    name: "same-key rollover names the successor it recorded",
    takeOverKey: async (storePath: string, sessionKey: string) => {
      await upsertSessionEntryCore(
        { storePath, sessionKey },
        { sessionId: "session-archive-prepare-successor", updatedAt: 3 },
      );
    },
    expectedDetails: {
      code: "SESSION_CHANGED",
      successorSessionId: "session-archive-prepare-successor",
    },
  },
  {
    name: "wholesale replacement names none",
    takeOverKey: async (storePath: string, sessionKey: string) => {
      await replaceSessionEntry(
        { storePath, sessionKey },
        sessionStoreEntry("session-archive-prepare-successor", { updatedAt: 3 }),
      );
    },
    expectedDetails: { code: "SESSION_CHANGED" },
  },
])(
  "sessions.patch reports an archive raced before its preparation read: $name",
  async ({ takeOverKey, expectedDetails }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-prepare-race";
    const sessionId = "session-archive-prepare-race";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const contenderRelease = createDeferredCore();
    // Holding the lifecycle fence keeps the archive queued after its preflight read but
    // before preparation re-reads the store, which is the window this rejection owns.
    const contender = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => await contenderRelease.promise,
    });
    try {
      const archive = directSessionReq("sessions.patch", {
        key: sessionKey,
        archived: true,
        expectedSessionId: sessionId,
      });
      // Let the request finish its preflight read and queue on the fence; it cannot pass
      // the fence until this test releases the contender, so the window stays open.
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      await takeOverKey(storePath, sessionKey);
      contenderRelease.resolve();

      const archived = await archive;
      expect(archived.ok).toBe(false);
      expect((archived.error as { details?: unknown } | undefined)?.details).toEqual(
        expectedDetails,
      );
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    } finally {
      contenderRelease.resolve();
      await contender;
    }
  },
);
