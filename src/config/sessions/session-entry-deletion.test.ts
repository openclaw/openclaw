import { channel } from "node:diagnostics_channel";
import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as archive from "./session-accessor.sqlite-archive.js";
import { readLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-store.js";
import {
  replaceSessionEntry as replace,
  replaceSessionEntrySync as seed,
} from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { deleteSessionEntryInAgentWorker } from "./session-entry-deletion.worker.js";
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

it.each([false, true])(
  "prepares retained-window references before BEGIN and rechecks writes (%s)",
  async (changed) => {
    const { scope } = await fixture();
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const survivor = "agent:main:survivor";
    seed(
      { ...scope, sessionKey: survivor },
      {
        sessionId: "survivor",
        previousSessionId: initial.sessionId,
        updatedAt: 1,
      },
    );
    const target = { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] };
    database.db
      .prepare(
        "INSERT OR IGNORE INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
      )
      .run(initial.sessionId, scope.sessionKey);
    const preparedTargetSnapshot = readLifecycleTargetSnapshot(database, target);
    const plan = {
      kind: "entry" as const,
      databaseOptions: resolveSessionReclamationDatabaseOptions({
        agentId: "main",
        path: database.path,
      }),
      deleteParams: {
        agentId: "main",
        storePath: database.path,
        target,
        archiveTranscript: false,
        expectedEntry: preparedTargetSnapshot[0]!.entry,
      },
      preparedTargetSnapshot,
      materializedPlans: [],
    };
    const scans: boolean[] = [];
    const statements = channel("openclaw.database.statement");
    const observe = (event: unknown) => {
      if (
        event &&
        typeof event === "object" &&
        "sql" in event &&
        typeof event.sql === "string" &&
        event.sql.startsWith('with "projected_nodes"') &&
        event.sql.includes('order by "session_key"')
      ) {
        scans.push(database.db.isTransaction);
      }
    };
    statements.subscribe(observe);
    const workerAdmission = admission.createSqliteWorkerOperationAdmission((_request, grant) =>
      grant(),
    );
    const { port1, port2 } = new MessageChannel();
    const post = port1.postMessage.bind(port1);
    vi.spyOn(port1, "postMessage").mockImplementation((message, transferList) => {
      post(message, transferList);
      const received: unknown = receiveMessageOnPort(port2)?.message;
      if (!isRecord(received)) {
        throw new Error("Missing native admission frame");
      }
      if (received.kind !== "native-commit" && received.kind !== "native-settlement") {
        workerAdmission.port.postMessage(
          received,
          received.port instanceof MessagePort ? [received.port] : [],
        );
        workerAdmission.service();
      }
    });
    try {
      admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
        deleteSessionEntryInAgentWorker(
          { plan },
          {
            options: { agentId: "main", path: database.path },
            open: () => database,
            admit() {},
            writeTransaction(label, _owner, write) {
              if (changed) {
                seed({ ...scope, sessionKey: survivor }, { sessionId: "survivor", updatedAt: 2 });
              }
              return runOpenClawAgentWriteTransaction(
                write,
                { agentId: "main", path: database.path },
                { operationLabel: label },
              );
            },
          },
        ),
      );
    } finally {
      port1.close();
      port2.close();
      await workerAdmission.finish();
      statements.unsubscribe(observe);
    }
    expect(scans).toEqual(changed ? [false, true] : [false]);
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(initial.sessionId),
    ).toEqual({ session_key: changed ? scope.sessionKey : survivor });
    expect(await read(scope)).toBeUndefined();
    // Repeating the lifecycle request finds no logical entry and does not scan survivors.
    await expect(deleteSessionEntryLifecycle(plan.deleteParams)).resolves.toMatchObject({
      deleted: false,
    });
  },
);
