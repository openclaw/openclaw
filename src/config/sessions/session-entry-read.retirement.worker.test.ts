import { expect, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isActiveStoreWriter } from "../../shared/store-writer-queue.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { test } from "./session-entry-fixture.test-support.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { projectionLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";

test.for(["refusal", "eviction"] as const)(
  "settles ordered exact-entry %s without waiting on the following writer",
  async (settlement, { store }) => {
    const { database, options, sessionKey, input: readInput } = store;
    const entry = { sessionId: "ordered-retirement-session", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, entry);
    // The test owns worker settlement, so discard the write's retained row facts.
    sessionChanges.invalidate({ sessionKey, storePath: database.path, factsInvalidated: true });
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const writerSettled = createDeferredCore();
    let following: Promise<string> | undefined;
    let reads = 0;
    const rotate = projectionLane.pool.rotate.bind(projectionLane.pool);
    using mocks = new DisposableStack();
    mocks.use(
      vi.spyOn(projectionLane.pool, "rotate").mockImplementation(() => {
        if (!isActiveStoreWriter(SQLITE_SESSION_WRITER_QUEUES, database.path)) {
          return rotate();
        }
        cleanupEntered.resolve();
        return Promise.race([writerSettled.promise, releaseCleanup.promise]);
      }),
    );
    for (const { pool } of [projectionLane, targetDiscoveryLane]) {
      const run = pool.run.bind(pool);
      mocks.use(vi.spyOn(pool, "canCloseNativeResources").mockReturnValue(false));
      mocks.use(
        vi.spyOn(pool, "run").mockImplementation(async (input, controls) => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind !== "session-exact-entries") {
            return run(request, controls);
          }
          reads += 1;
          return settlement === "refusal"
            ? { ok: false, error: { kind: "projection", sessionId: entry.sessionId } }
            : {
                ok: true,
                value: {
                  kind: "session-exact-entries",
                  entries: [{ sessionKey, entry }],
                  lifecycleTimestamps: {},
                },
                closedHistoryDatabase: request.database,
              };
        }),
      );
    }
    const consume = vi.fn();
    const reading = withSessionEntriesFromStoresInWorker(
      [{ ...readInput, projection: "list" }],
      ([read]) => {
        consume();
        return read!.result.entries[0]?.entry;
      },
      {
        ordered: true,
        onReadAdmitted: () => {
          following = runOpenClawAgentWriteAdmission(options, () => {
            writerSettled.resolve();
            return "following writer";
          });
        },
      },
    );
    try {
      const outcome = await Promise.race([
        reading.catch((error: unknown) => error),
        cleanupEntered.promise.then(() => new Error("Cleanup waits on its queued writer")),
      ]);
      if (settlement === "refusal") {
        expect(outcome).toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
        expect(consume).not.toHaveBeenCalled();
      } else {
        expect(outcome).toEqual(entry);
        expect(consume).toHaveBeenCalledOnce();
      }
      expect(reads).toBe(1);
      await expect(following).resolves.toBe("following writer");
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([reading, following]);
    }
  },
);
