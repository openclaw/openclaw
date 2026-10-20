import { performance } from "node:perf_hooks";
import { expect, test, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { invokeProjectMethod, projectsHandlers } from "./projects.test-support.js";

test("project recents do not enumerate unrelated sessions after projection hydration", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "recents-perf-" });
  const release = retainSessionListForegroundWork();
  const cfg = { agents: { entries: { main: {} } } };
  let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  try {
    const profile = ensureProfileForEmail("recents@example.test");
    const now = Date.now();
    const unrelated = 4_096;
    const marker = "agent:main:unrelated-0";
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < unrelated + 32; index++) {
          const foreign = index < unrelated;
          const own = index - unrelated;
          const key = foreign ? `agent:main:unrelated-${index}` : `agent:main:recent-${own}`;
          writeSessionEntry(
            database,
            key,
            {
              sessionId: key,
              updatedAt: now - index,
              archivedAt: now,
              createdActor: {
                type: "human",
                source: "profile",
                id: foreign ? "other" : profile.id,
              },
              spawnedCwd: foreign ? "/work/foreign" : `/work/recent-${Math.max(0, own - 24)}`,
            },
            { canonicalPreviousEntry: null, previousEntry: null },
          );
        }
      },
      { agentId: "main" },
    );
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const request = () =>
      invokeProjectMethod(
        "projects.list",
        {},
        cfg,
        ["operator.write"],
        profile.id,
        projectsHandlers,
        projection,
      );
    const expected = Array.from({ length: 8 }, (_, index) => ({
      kind: "folder",
      folder: `/work/recent-${index}`,
      displayName: `recent-${index}`,
    }));
    for (let index = 0; index < 2; index++) {
      expect(await request()).toMatchObject({ ok: true, payload: { recents: expected } });
    }
    const originalEntries = Object.entries;
    let enumerated = 0;
    const enumeration = vi.spyOn(Object, "entries").mockImplementation((value) => {
      const entries = originalEntries(value);
      if (Object.hasOwn(value, marker)) {
        enumerated += entries.length;
      }
      return entries;
    });
    const elapsed: number[] = [];
    try {
      for (let index = 0; index < 7; index++) {
        const start = performance.now();
        const result = await request();
        elapsed.push(performance.now() - start);
        expect(result).toMatchObject({ ok: true, payload: { recents: expected } });
      }
    } finally {
      enumeration.mockRestore();
    }
    console.info(
      JSON.stringify({
        boundary: "projects.list",
        unrelated,
        iterations: elapsed.length,
        medianMs: elapsed.toSorted((a, b) => a - b)[3],
        globallyEnumeratedRowsPerRequest: enumerated / elapsed.length,
      }),
    );
    expect(enumerated).toBe(0);

    const changed = "agent:main:recent-0";
    const moved = {
      sessionId: changed,
      updatedAt: now + 1,
      archivedAt: now,
      createdActor: { type: "human" as const, source: "profile" as const, id: profile.id },
      spawnedCwd: "/work/moved",
    };
    // A receipt without a postimage must reenter the existing exact-key worker admission.
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, changed, moved);
      },
      { agentId: "main" },
    );
    sessionChanges.emit({
      agentId: "main",
      sessionKey: changed,
      scope: "session-entry",
      factsInvalidated: true,
    });
    expect(await request()).toMatchObject({
      ok: true,
      payload: {
        recents: [
          { kind: "folder", folder: "/work/moved", displayName: "moved" },
          ...expected.slice(0, 7),
        ],
      },
    });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: changed },
      {
        ...moved,
        updatedAt: now - unrelated,
        spawnedCwd: "/work/recent-0",
      },
    );
    expect(await request()).toMatchObject({ ok: true, payload: { recents: expected } });
    const removed = "agent:main:recent-31";
    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: projection.capture({ agentId: "main", key: removed })!.storeTarget.storePath,
      archiveTranscript: false,
      target: { canonicalKey: removed, storeKeys: [removed] },
    });
    expect(await request()).toMatchObject({ ok: true, payload: { recents: expected.slice(0, 7) } });
  } finally {
    projection?.dispose();
    release();
    await state.cleanup();
  }
});
