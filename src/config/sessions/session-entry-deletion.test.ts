import { afterEach, expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

it("deletes a completed run alias without losing the shared transcript or retaining a cached entry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const events = [
      { type: "session", id: f.scope.sessionId, version: 3 },
      {
        type: "message",
        id: "retained-message",
        message: { role: "user", content: "Retain the stable conversation." },
      },
    ];
    await replaceTranscriptEvents(f.scope, events);
    const alias = { ...f.scope, sessionKey: "agent:main:cron:job:run:completed" };
    replaceSessionEntrySync(alias, {
      sessionId: f.scope.sessionId,
      updatedAt: 2,
      label: "completed run",
    });
    const expectedEntry = await readSessionEntryInWorker(alias);
    expect(expectedEntry).toMatchObject({ sessionId: "original", label: "completed run" });

    await expect(
      deleteSessionEntryLifecycle({
        ...alias,
        target: { canonicalKey: alias.sessionKey, storeKeys: [alias.sessionKey] },
        archiveTranscript: false,
        expectedEntry,
      }),
    ).resolves.toMatchObject({ deleted: true, archivedTranscripts: [] });

    await expect(readSessionEntryInWorker(alias)).resolves.toBeUndefined();
    await expect(readSessionEntryInWorker(f.scope)).resolves.toMatchObject({
      sessionId: "original",
      label: "initial",
    });
    await expect(loadSessionTranscriptEvents(f.scope)).resolves.toEqual(events);
  });
});

it.each([
  { change: "metadata", sessionId: "original", label: "new metadata" },
  { change: "identity", sessionId: "replacement", label: "replacement session" },
])(
  "keeps an entry changed by an in-process $change write after cleanup captured it",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const expectedEntry = await readSessionEntryInWorker(f.scope);
      expect(expectedEntry).toMatchObject({ sessionId: "original", label: "initial" });
      await replaceSessionEntry(f.scope, {
        sessionId: change.sessionId,
        label: change.label,
        updatedAt: 2,
      });

      await expect(
        deleteSessionEntryLifecycle({
          ...f.scope,
          target: f.target,
          archiveTranscript: false,
          expectedEntry,
        }),
      ).resolves.toMatchObject({ deleted: false, expectedEntryMismatch: true });
      await expect(readSessionEntryInWorker(f.scope)).resolves.toMatchObject({
        sessionId: change.sessionId,
        label: change.label,
        updatedAt: 2,
      });
    });
  },
);

it("rolls back entry deletion when cleanup authority is lost at native commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
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
        deleteSessionEntryLifecycle({
          ...f.scope,
          target: f.target,
          archiveTranscript: false,
          expectedEntry,
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
