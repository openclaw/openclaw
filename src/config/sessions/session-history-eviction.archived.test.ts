import path from "node:path";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionEntry } from "./types.js";

const test = sessionTests({ prefix: "archived-eviction-", layout: "state-only" });
const key = "agent:main:archived-victim";
const victim: SessionEntry = {
  sessionId: "archived-victim",
  updatedAt: 1,
  archivedAt: 10,
  archiveReason: "active-session-cap",
};

test("preserves archive cursor ties, page limits, and protected rows across worker batches", async ({
  store: { options },
}) => {
  runOpenClawAgentWriteTransaction((database) => {
    for (let index = 0; index < 66; index++) {
      writeSessionEntry(database, `agent:main:protected-${index}`, {
        ...victim,
        sessionId: `protected-${index}`,
        archiveReason: "manual",
      });
    }
    writeSessionEntry(database, "agent:main:eligible-a", victim);
    writeSessionEntry(database, "agent:main:eligible-b", { ...victim, sessionId: "second" });
    writeSessionEntry(database, "agent:main:live", { ...victim, sessionId: "live" });
    writeSessionEntry(database, "agent:main:pinned", { ...victim, pinnedAt: 1 });
    writeSessionEntry(database, "agent:main:recent", { ...victim, updatedAt: Date.now() });
  }, options);
  await withSessionHistoryWorkerDatabase(
    options,
    async (owner) => {
      const read = (after?: { archivedAt: number; sessionKey: string }) =>
        owner.readArchivedEvictionCandidates({
          env: process.env,
          archived: {
            after,
            limit: 1,
            preserveRecentMs: 60_000,
            liveSessionKeys: ["agent:main:live"],
          },
        });
      const first = await read();
      expect(first).toMatchObject({
        candidates: [{ sessionKey: "agent:main:eligible-a", entry: victim }],
        cursor: { archivedAt: 10, sessionKey: "agent:main:eligible-a" },
        exhausted: false,
      });
      const second = await read(first.cursor);
      expect(second.candidates.map((candidate) => candidate.sessionKey)).toEqual([
        "agent:main:eligible-b",
      ]);
      const last = await read(second.cursor);
      expect(last).toMatchObject({
        candidates: [],
        exhausted: true,
        cursor: { archivedAt: 10, sessionKey: "agent:main:recent" },
      });
    },
    maintenanceLane,
  );
});

test.for(["rebound", "admitted", "registered", "rejected", "revoked"] as const)(
  "refuses stale archived eviction after a delayed batch is %s",
  async (outcome, { state, store: { options } }) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const writeVictim = (entry = victim) =>
      runOpenClawAgentWriteTransaction((db) => writeSessionEntry(db, key, entry), options);
    writeVictim();
    const reached = createDeferred();
    const release = createDeferred();
    const createReaders = workerReaders.createSessionHistoryWorkerReaders;
    using readers = vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders");
    readers.mockImplementation((run) =>
      createReaders(async (...args) => {
        const input = args[0]();
        const result = await run(...args);
        if (input.kind === "historical-eviction-candidates" && "archived" in input) {
          reached.resolve();
          await release.promise;
          if (outcome === "rejected") {
            throw new Error("archived batch rejected");
          }
        }
        return result;
      }),
    );
    const sweep = enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
    });
    const result = sweep.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(reached.promise, sweep, "Archived worker read was bypassed");
      if (outcome === "rebound") {
        writeVictim({ sessionId: "replacement", updatedAt: 20 });
      } else if (outcome === "admitted") {
        admission = await beginSessionEffect({
          scope: storePath,
          identities: [key, victim.sessionId],
          assertAllowed: () => {},
        });
      } else if (outcome === "registered") {
        registerAgentRunContext("archived-live-run", {
          agentId: "main",
          sessionKey: key,
          projectSessionActive: true,
        });
      } else if (outcome === "revoked") {
        closing = closeOpenClawAgentDatabaseByPathAsync(options.path);
      }
      release.resolve();
      const settled = await result;
      if (outcome === "rebound") {
        expect(settled).toMatchObject({ value: { removedEntries: 0 } });
      } else {
        const message = {
          admitted: "competing work is in flight",
          registered: "Session became active",
          rejected: "archived batch rejected",
          revoked: "revoked",
        }[outcome];
        expect(settled).toMatchObject({ error: { message: expect.stringContaining(message) } });
      }
      await closing;
      expect(loadSessionEntryReadOnly({ sessionKey: key, storePath })?.sessionId).toBe(
        outcome === "rebound" ? "replacement" : victim.sessionId,
      );
    } finally {
      release.resolve();
      clearAgentRunContext("archived-live-run");
      admission?.release();
      await result;
      await closing;
    }
  },
);
