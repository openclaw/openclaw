import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

it("preserves a keyed replacement while an older worker reply is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const query = { agentId: "main", key: "agent:main:worker-replacement" };
    const entry = { sessionId: "original", updatedAt: 1 };
    replaceSessionEntrySync({ agentId: query.agentId, sessionKey: query.key }, entry);
    const releaseForeground = retainSessionListForegroundWork();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    const projection = await createSessionRowProjection({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
    });
    try {
      await projection.ensureMaterialized();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementationOnce(
        (databases, consume) =>
          readDatabases(databases, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  entered.resolve();
                  await release.promise;
                  return reply;
                },
              })),
            ),
          ),
      );
      sessionChanges.emit({ agentId: query.agentId, sessionKey: query.key });
      reading = projection.ensureMaterialized();
      await entered.promise;
      // A direct reader can discover a new lifecycle independently of bulk publication.
      vi.spyOn(entryCache, "readCommittedSessionEntryCache").mockReturnValueOnce(
        new Map([[query.key, { ...entry, sessionId: "replacement" }]]),
      );
      const replacement = projection.describe(query);
      expect(replacement?.entry.sessionId).toBe("replacement");
      release.resolve();
      await reading;
      expect(projection.isCurrent(replacement!)).toBe(true);
      expect(projection.snapshot(query).row?.sessionId).toBe("replacement");
    } finally {
      release.resolve();
      await reading;
      projection.dispose();
      releaseForeground();
    }
  });
});
