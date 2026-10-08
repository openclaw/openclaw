import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionEntry } from "./types.js";

let state: OpenClawTestState;
let storePath: string;
let options: { agentId: string; path: string };
const key = "agent:main:archived-victim";
const victim: SessionEntry = {
  sessionId: "archived-victim",
  updatedAt: 1,
  archivedAt: 10,
  archiveReason: "active-session-cap",
};

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "archived-eviction-", layout: "state-only" });
  storePath = path.join(state.sessionsDir(), "sessions.json");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  options = { agentId: "main", path: database.path };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await state.cleanup();
});

it("preserves archive cursor ties, page limits, and protected rows across worker batches", async () => {
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
      const first = await owner.readArchivedEvictionCandidates({
        env: process.env,
        archived: { limit: 1, preserveRecentMs: 60_000, liveSessionKeys: ["agent:main:live"] },
      });
      expect(first).toMatchObject({
        candidates: [{ sessionKey: "agent:main:eligible-a", entry: victim }],
        cursor: { archivedAt: 10, sessionKey: "agent:main:eligible-a" },
        exhausted: false,
      });
      const second = await owner.readArchivedEvictionCandidates({
        env: process.env,
        archived: {
          after: first.cursor,
          limit: 1,
          preserveRecentMs: 60_000,
          liveSessionKeys: ["agent:main:live"],
        },
      });
      expect(second.candidates.map((candidate) => candidate.sessionKey)).toEqual([
        "agent:main:eligible-b",
      ]);
      const last = await owner.readArchivedEvictionCandidates({
        env: process.env,
        archived: {
          after: second.cursor,
          limit: 1,
          preserveRecentMs: 60_000,
          liveSessionKeys: ["agent:main:live"],
        },
      });
      expect(last).toMatchObject({
        candidates: [],
        exhausted: true,
        cursor: { archivedAt: 10, sessionKey: "agent:main:recent" },
      });
    },
    maintenanceLane,
  );
});

it.each(["rebound", "admitted", "registered", "rejected", "revoked"] as const)(
  "refuses stale archived eviction after a delayed batch is %s",
  async (outcome) => {
    runOpenClawAgentWriteTransaction(
      (database) => writeSessionEntry(database, key, victim),
      options,
    );
    const reached = createDeferred();
    const release = createDeferred();
    const createReaders = workerReaders.createSessionHistoryWorkerReaders;
    vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) =>
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
    let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(reached.promise, sweep, "Archived worker read was bypassed");
      if (outcome === "rebound") {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, key, { sessionId: "replacement", updatedAt: 20 }),
          options,
        );
      } else if (outcome === "admitted") {
        admission = await beginSessionWorkAdmission({
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
