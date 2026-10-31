import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as archive from "./session-accessor.sqlite-archive.js";
import {
  replaceSessionEntry as replace,
  replaceSessionEntrySync as seed,
} from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionEntryInWorker as read } from "./session-entry-read-writable.js";
import { loadSessionTranscriptEvents as transcript } from "./session-transcript-events.js";

// mock-isolation: Background maintenance must not race exact deletion fixtures.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget maintenance must not evict histories while deletion fixtures assert them.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));
afterEach(() => vi.restoreAllMocks());
let state: OpenClawTestState;
it.aroundEach((run) =>
  withOpenClawTestState({ scenario: "minimal" }, async (current) => {
    state = current;
    await run();
  }),
);

const initial = { sessionId: "original", updatedAt: 1, label: "initial" };
const deleted = { deleted: true, archivedTranscripts: [] };
async function fixture(shared = false) {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    ...(shared ? { path: state.path("shared.sqlite") } : {}),
  });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:compound-worker",
    sessionId: initial.sessionId,
  };
  seed(scope, initial);
  return { scope, remove: await capture(scope) };
}
async function capture(scope: Parameters<typeof read>[0] & { storePath: string }) {
  const expectedEntry = await read(scope);
  return (options: { archiveTranscript?: boolean; commitGuard?: () => void } = {}) =>
    deleteSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      archiveTranscript: false,
      expectedEntry,
      ...options,
    });
}

it.each(["main", "other"])(
  "deletes a completed %s alias without losing shared history",
  async (agentId) => {
    const { scope } = await fixture(true);
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "retained", message: { role: "user", content: "keep" } },
    ];
    await replaceTranscriptEvents(scope, events);
    const alias = { ...scope, agentId, sessionKey: `agent:${agentId}:cron:job:run:completed` };
    const aliasEntry = { sessionId: scope.sessionId, updatedAt: 2, label: "completed run" };
    seed(alias, aliasEntry);
    const remove = await capture(alias);
    const facts: Array<SessionRowFacts | undefined> = [];
    const unsubscribe = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === alias.sessionKey) {
        facts.push(change.facts);
      }
    });
    onTestFinished(unsubscribe);
    await expect(remove()).resolves.toMatchObject(deleted);
    unsubscribe();
    expect(facts).toContainEqual({
      kind: "removed",
      ...(agentId === "main" ? { transcriptInventoryUnchanged: true } : {}),
    });
    expect(await Promise.all([read(alias), read(scope), transcript(scope)])).toEqual([
      undefined,
      expect.objectContaining(initial),
      events,
    ]);
  },
);

it.each([
  { change: "metadata", sessionId: "original", label: "new metadata" },
  { change: "identity", sessionId: "replacement", label: "replacement session" },
])("preserves a captured entry after a $change write", async ({ sessionId, label }) => {
  const { scope, remove } = await fixture();
  const replacement = { sessionId, label, updatedAt: 2 };
  await replace(scope, replacement);
  await expect(remove()).resolves.toMatchObject({
    deleted: false,
    expectedEntryMismatch: true,
  });
  await expect(read(scope)).resolves.toMatchObject(replacement);
});

it("rolls back deletion when cleanup authority is lost at native commit", async () => {
  const { scope, remove } = await fixture();
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
  await expect(
    remove({
      commitGuard() {
        if (!authorityCurrent) {
          throw new Error("cleanup lease lost");
        }
      },
    }),
  ).rejects.toThrow("cleanup lease lost");
  interception.mockRestore();
  expect(authorityCurrent).toBe(false);
  await expect(read(scope)).resolves.toMatchObject({ sessionId: "original", label: "initial" });
});

it("deletes empty transcripts without starting an archive worker", async () => {
  const { scope, remove } = await fixture();
  const createArchiveWorker = vi.spyOn(archive, "createSqliteTranscriptArchiveWorker");
  await expect(remove({ archiveTranscript: true })).resolves.toMatchObject(deleted);
  expect(await Promise.all([read(scope), transcript(scope)])).toEqual([undefined, []]);
  expect(createArchiveWorker).not.toHaveBeenCalled();
});
