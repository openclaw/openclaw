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
  const expected = await read(scope);
  expect(expected).toMatchObject(initial);
  return { scope, expected };
}
const remove = (
  scope: Awaited<ReturnType<typeof fixture>>["scope"],
  expectedEntry: Awaited<ReturnType<typeof read>>,
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
  "deletes a completed %s alias without losing shared history",
  async (agentId) => {
    const { scope } = await fixture(true);
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
    seed(alias, { sessionId: scope.sessionId, updatedAt: 2, label: "completed run" });
    const expected = await read(alias);
    expect(expected).toMatchObject({ sessionId: "original", label: "completed run" });
    const facts: Array<SessionRowFacts | undefined> = [];
    const unsubscribe = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === alias.sessionKey) {
        facts.push(change.facts);
      }
    });
    onTestFinished(unsubscribe);
    await expect(remove(alias, expected)).resolves.toMatchObject({
      deleted: true,
      archivedTranscripts: [],
    });
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
  const { scope, expected } = await fixture();
  const replacement = { sessionId, label, updatedAt: 2 };
  await replace(scope, replacement);
  await expect(remove(scope, expected)).resolves.toMatchObject({
    deleted: false,
    expectedEntryMismatch: true,
  });
  await expect(read(scope)).resolves.toMatchObject(replacement);
});

it("rolls back deletion when cleanup authority is lost at native commit", async () => {
  const { scope, expected } = await fixture();
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
    remove(scope, expected, {
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
  const { scope: base } = await fixture();
  const createArchiveWorker = vi.spyOn(archive, "createSqliteTranscriptArchiveWorker");
  for (const sessionId of ["first", "second", "third"]) {
    const scope = { ...base, sessionKey: `agent:main:empty-${sessionId}`, sessionId };
    const entry = { sessionId, updatedAt: 1 };
    await replace(scope, entry);
    const expected = await read(scope);
    expect(expected).toMatchObject(entry);
    await expect(remove(scope, expected, { archiveTranscript: true })).resolves.toMatchObject({
      deleted: true,
      archivedTranscripts: [],
    });
    expect(await Promise.all([read(scope), transcript(scope)])).toEqual([undefined, []]);
  }
  expect(createArchiveWorker).not.toHaveBeenCalled();
});
