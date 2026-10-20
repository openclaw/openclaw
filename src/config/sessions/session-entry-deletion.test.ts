import { afterEach, expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archive from "./session-accessor.sqlite-archive.js";
import { replaceSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionEntryInWorker } from "./session-entry-read-writable.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";

// mock-isolation: Background maintenance is independent of exact entry deletion.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget eviction must not race the destructive authority fixture.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof createSessionCompoundWorkerFixture>;
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () =>
    run(createSessionCompoundWorkerFixture()),
  );
}
const deleteExpected = (
  scope: Fixture["scope"],
  expectedEntry: Awaited<ReturnType<typeof readSessionEntryInWorker>>,
  options: { archiveTranscript?: boolean; commitGuard?: () => void } = {},
) =>
  deleteSessionEntryLifecycle({
    ...scope,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    archiveTranscript: false,
    expectedEntry,
    ...options,
  });

it.each(["main", "other"])(
  "deletes a completed %s run alias while reporting transcript attribution changes",
  async (agentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const scope = {
        agentId: "main",
        storePath,
        sessionKey: "agent:main:compound-worker",
        sessionId: "original",
      };
      const initial = { sessionId: scope.sessionId, updatedAt: 1, label: "initial" };
      replaceSessionEntrySync(scope, initial);
      const events = [
        { type: "session", id: scope.sessionId, version: 3 },
        {
          type: "message",
          id: "retained-message",
          message: { role: "user", content: "Retain the stable conversation." },
        },
      ];
      await replaceTranscriptEvents(scope, events);
      const alias = { ...scope, agentId, sessionKey: `agent:${agentId}:cron:job:run:completed` };
      replaceSessionEntrySync(alias, {
        sessionId: scope.sessionId,
        updatedAt: 2,
        label: "completed run",
      });
      const expectedEntry = await readSessionEntryInWorker(alias);
      expect(expectedEntry).toMatchObject({ sessionId: "original", label: "completed run" });

      const facts: Array<SessionRowFacts | undefined> = [];
      const unsubscribe = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === alias.sessionKey) {
          facts.push(change.facts);
        }
      });
      try {
        await expect(deleteExpected(alias, expectedEntry)).resolves.toMatchObject({
          deleted: true,
          archivedTranscripts: [],
        });
      } finally {
        unsubscribe();
      }
      expect(facts).toContainEqual({
        kind: "removed",
        ...(agentId === "main" ? { transcriptInventoryUnchanged: true } : {}),
      });

      await expect(readSessionEntryInWorker(alias)).resolves.toBeUndefined();
      await expect(readSessionEntryInWorker(scope)).resolves.toMatchObject(initial);
      await expect(loadSessionTranscriptEvents(scope)).resolves.toEqual(events);
    });
  },
);

it.each([
  { change: "metadata", sessionId: "original", label: "new metadata" },
  { change: "identity", sessionId: "replacement", label: "replacement session" },
])(
  "keeps an entry changed by an in-process $change write after cleanup captured it",
  async (change) => {
    await withFixture(async (f) => {
      const expectedEntry = await readSessionEntryInWorker(f.scope);
      expect(expectedEntry).toMatchObject({ sessionId: "original", label: "initial" });
      const replacement = { sessionId: change.sessionId, label: change.label, updatedAt: 2 };
      await replaceSessionEntry(f.scope, replacement);

      await expect(deleteExpected(f.scope, expectedEntry)).resolves.toMatchObject({
        deleted: false,
        expectedEntryMismatch: true,
      });
      await expect(readSessionEntryInWorker(f.scope)).resolves.toMatchObject(replacement);
    });
  },
);

it("rolls back entry deletion when cleanup authority is lost at native commit", async () => {
  await withFixture(async (f) => {
    const expectedEntry = await readSessionEntryInWorker(f.scope);
    expect(expectedEntry).toMatchObject({ sessionId: "original", label: "initial" });
    let authorityCurrent = true;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    const interception = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            authorityCurrent = false;
          }
          callback(request, grant);
        }, attachment),
      );
    try {
      await expect(
        deleteExpected(f.scope, expectedEntry, {
          commitGuard() {
            if (!authorityCurrent) {
              throw new Error("cleanup lease lost");
            }
          },
        }),
      ).rejects.toThrow("cleanup lease lost");
    } finally {
      interception.mockRestore();
    }
    expect(authorityCurrent).toBe(false);
    await expect(readSessionEntryInWorker(f.scope)).resolves.toMatchObject({
      sessionId: "original",
      label: "initial",
    });
  });
});

it("deletes empty transcripts through the admitted writer without starting an archive worker", async () => {
  await withFixture(async (f) => {
    const createArchiveWorker = vi.spyOn(archive, "createSqliteTranscriptArchiveWorker");
    for (const suffix of ["first", "second", "third"]) {
      const scope = { ...f.scope, sessionKey: `agent:main:empty-${suffix}`, sessionId: suffix };
      const entry = { sessionId: suffix, updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const expectedEntry = await readSessionEntryInWorker(scope);
      expect(expectedEntry).toMatchObject(entry);
      await expect(
        deleteExpected(scope, expectedEntry, { archiveTranscript: true }),
      ).resolves.toMatchObject({ deleted: true, archivedTranscripts: [] });
      await expect(readSessionEntryInWorker(scope)).resolves.toBeUndefined();
      await expect(loadSessionTranscriptEvents(scope)).resolves.toEqual([]);
    }
    expect(createArchiveWorker).not.toHaveBeenCalled();
  });
});
