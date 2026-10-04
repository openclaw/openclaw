import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  type SessionPendingInputOwner,
} from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { createIncognitoSessionHistoryReader } from "../gateway/session-history-snapshot.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-pending-history-") };
  const open = workerStore.openEphemeralAgentDatabaseSqliteWorkerStore;
  const fixture = vi
    .spyOn(workerStore, "openEphemeralAgentDatabaseSqliteWorkerStore")
    .mockImplementation((options, custody) =>
      open(
        {
          ...options,
          moduleUrl: new URL(
            "./openclaw-agent-execution-incognito.pending-fixture.test-support.ts",
            import.meta.url,
          ),
        },
        custody,
      ),
    );
  try {
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env,
      authority,
    });
    assert(opened);
    actor = opened;
  } finally {
    fixture.mockRestore();
  }
});

beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

function target(name: string) {
  return {
    sessionKey: `agent:main:dashboard:incognito-pending-${name}`,
    sessionId: `pending-${name}`,
    lifecycleRevision: "initial",
  };
}

async function reader(name: string, owner = actor) {
  const selected = target(name);
  await owner.sessions.read(authority, { sessionKey: selected.sessionKey });
  return createIncognitoSessionHistoryReader({
    actor: owner,
    authority,
    target: { ...selected, agentId: owner.agentId, storePath: owner.path },
    subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
    resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" }),
  });
}

function pendingOwner(name: string): SessionPendingInputOwner {
  const selected = target(name);
  const id = `${name}-first`;
  const owner: SessionPendingInputOwner = {
    inputId: id,
    transcriptInputId: id,
    ...selected,
    databasePath: actor.path,
    workerDatabasePath: actor.path,
    idempotencyKey: `${id}:user`,
    lifecycleGeneration: actor.identity.incarnation,
    messageJson: JSON.stringify({ role: "user", content: `Synthetic ${id}` }),
    settling: true,
    assertCurrent() {
      throw new Error("Execution ended; terminal disposition remains owned");
    },
    finish() {
      releaseSessionPendingInputOwner(owner);
    },
  };
  return owner;
}

function snapshot(name: string) {
  return actor.sessions.history(authority, {
    type: "session.history.pending-inputs",
    input: { ...target(name), query: {} },
  });
}

function interceptInterruptionReply(afterCommit: () => void | Promise<void>) {
  const run = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof run>[2],
        assertCurrent?: Parameters<typeof run>[3],
        createAdmission?: Parameters<typeof run>[4],
      ) =>
        run(
          store,
          (scope) =>
            operation({
              execute: async (command, options) => {
                const result = await scope.execute(command, options);
                if (command.type === "session.pendingInputs.interruptHistory") {
                  await afterCommit();
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission,
        ),
    );
}

it("pages and reads exact actor inputs while preserving terminal disposition custody", async () => {
  const history = await reader("page");
  const owner = pendingOwner("page");
  registerSessionPendingInputOwner(owner);
  try {
    const newest = await history.listPendingInputs({ limit: 1 });
    expect(newest).toMatchObject({
      total: 3,
      items: [
        { id: "page-third", state: "interrupted", message: { content: "Synthetic page-third" } },
      ],
    });
    expect(newest.nextBefore).toBeDefined();
    const older = await history.listPendingInputs({ limit: 1, before: newest.nextBefore });
    expect(older.items).toMatchObject([{ id: "page-second", state: "interrupted" }]);
    const oldest = await history.listPendingInputs({ limit: 1, before: older.nextBefore });
    expect(oldest.items).toMatchObject([{ id: "page-first", state: "queued" }]);
    expect(oldest.nextBefore).toBeUndefined();
    expect(await history.readPendingInput("page-first")).toMatchObject({
      id: "page-first",
      state: "queued",
    });
    expect(await history.readPendingInput("missing")).toBeUndefined();
  } finally {
    releaseSessionPendingInputOwner(owner);
  }
});

it.each(["transaction", "commit"] as const)(
  "rechecks actor pending-input custody at the %s grant",
  async (phase) => {
    const history = await reader(phase);
    const owner = pendingOwner(phase);
    let registered = false;
    const create = workerAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        create((request, grant) => {
          if (request.stage === phase && !registered) {
            registerSessionPendingInputOwner(owner);
            registered = true;
          }
          callback(request, grant);
        }, attachment),
      );
    try {
      if (phase === "transaction") {
        await expect(history.listPendingInputs()).resolves.toMatchObject({
          items: [
            { id: "transaction-first", state: "queued" },
            { id: "transaction-second", state: "interrupted" },
          ],
        });
      } else {
        await expect(history.listPendingInputs()).rejects.toThrow("acquired live custody");
        expect((await snapshot(phase)).rows.map((row) => row.state)).toEqual(["queued", "queued"]);
      }
      expect(registered).toBe(true);
    } finally {
      admission.mockRestore();
      releaseSessionPendingInputOwner(owner);
    }
  },
);

it("recovers exact committed interruption IDs after losing the ordinary reply without replay", async () => {
  const history = await reader("lost");
  const owner = pendingOwner("lost");
  registerSessionPendingInputOwner(owner);
  let interruptions = 0;
  const delivery = interceptInterruptionReply(() => {
    interruptions++;
    throw new Error("Synthetic interruption reply loss");
  });
  try {
    await expect(history.listPendingInputs()).resolves.toMatchObject({
      items: [
        { id: "lost-first", state: "queued" },
        { id: "lost-second", state: "interrupted" },
      ],
    });
    expect(interruptions).toBe(1);
    expect((await snapshot("lost")).rows.map((row) => [row.input_id, row.state])).toEqual([
      ["lost-second", "interrupted"],
      ["lost-first", "queued"],
    ]);
  } finally {
    delivery.mockRestore();
    releaseSessionPendingInputOwner(owner);
  }
});

it("joins an accepted pending-history composition before releasing its actor borrow", async () => {
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const history = await reader("close", borrowed);
  const ready = createDeferredCore();
  const resume = createDeferredCore();
  const delivery = interceptInterruptionReply(async () => {
    ready.resolve();
    await resume.promise;
  });
  const reading = history.listPendingInputs();
  const rejected = expect(reading).rejects.toThrow("Incognito execution reference is released");
  let released = false;
  try {
    await awaitGateBeforeSettlement(
      ready.promise,
      reading,
      "History settled before the commit gate",
    );
    const releasing = borrowed.release().then(() => {
      released = true;
    });
    expect(released).toBe(false);
    resume.resolve();
    await Promise.all([rejected, releasing]);
    expect(released).toBe(true);
    expect((await snapshot("close")).rows.map((row) => row.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
  } finally {
    resume.resolve();
    await Promise.allSettled([reading, borrowed.release()]);
    delivery.mockRestore();
  }
});
