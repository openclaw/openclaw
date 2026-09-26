import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  isSqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { updateSessionEntry } from "./session-accessor.entry-mutation.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";

let state: OpenClawTestState;
let database: ReturnType<typeof openOpenClawAgentDatabase>;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  setRuntimeConfigSnapshot({}, {});
  database = openOpenClawAgentDatabase({ agentId: "main" });
});
afterAll(async () => {
  await state.cleanup();
});

function fixture(name: string) {
  const scope = { agentId: "main", storePath: database.path, sessionKey: `agent:main:${name}` };
  const original = { sessionId: name, lifecycleRevision: "original-lifecycle", updatedAt: 1 };
  writeSessionEntry(database, scope.sessionKey, original);
  return {
    scope,
    original,
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
  };
}

it("claims a turn writer without caller-thread data SQL or transaction entry", async () => {
  const f = fixture("worker-claim");
  const sql = observeHostDataSql();
  try {
    await expect(
      updateSessionEntry(f.scope, () => ({ activeWriterRunId: "claimed-run" }), {
        skipMaintenance: true,
      }),
    ).resolves.toMatchObject({
      sessionId: f.original.sessionId,
      lifecycleRevision: f.original.lifecycleRevision,
      activeWriterRunId: "claimed-run",
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(f.read()?.activeWriterRunId).toBe("claimed-run");
});

it("keeps competing patches FIFO and publishes committed facts in each caller's context", async () => {
  const f = fixture("worker-fifo");
  const contexts = new AsyncLocalStorage<string>();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  const stop = onSessionIdentityMutation((change) => {
    if (change.kind !== "delete" && change.current.sessionKeys.includes(f.scope.sessionKey)) {
      order.push(`published:${contexts.getStore()}`);
    }
  });
  const committed = () => ({
    skipMaintenance: true,
    onCommitted: (entry: NonNullable<ReturnType<typeof f.read>>) => {
      order.push(`committed:${contexts.getStore()}:${entry.activeWriterRunId}`);
    },
  });
  const first = contexts.run("first", () =>
    patchSessionEntryCore(
      f.scope,
      async () => {
        order.push(`prepare:${contexts.getStore()}`);
        entered.resolve();
        await release.promise;
        return { activeWriterRunId: "first-run", lifecycleRevision: "first-lifecycle" };
      },
      committed(),
    ),
  );
  let second: Promise<unknown> | undefined;
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("First patch settled without entering its updater");
      }),
    ]);
    second = contexts.run("second", () =>
      patchSessionEntryCore(
        f.scope,
        (entry) => {
          order.push(`prepare:${contexts.getStore()}:${entry.activeWriterRunId}`);
          return { activeWriterRunId: "second-run", lifecycleRevision: "second-lifecycle" };
        },
        committed(),
      ),
    );
    expect(order).toEqual(["prepare:first"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "prepare:first",
      "committed:first:first-run",
      "published:first",
      "prepare:second:first-run",
      "committed:second:second-run",
      "published:second",
    ]);
    expect(f.read()).toMatchObject({
      activeWriterRunId: "second-run",
      lifecycleRevision: "second-lifecycle",
    });
  } finally {
    release.resolve();
    await Promise.allSettled(second ? [first, second] : [first]);
    stop();
  }
});

it("rejects a session replacement committed while its worker snapshot is being prepared", async () => {
  const f = fixture("worker-replaced");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const committed = vi.fn();
  const patch = patchSessionEntryCore(
    f.scope,
    async () => {
      entered.resolve();
      await release.promise;
      return { activeWriterRunId: "stale-claim" };
    },
    { skipMaintenance: true, onCommitted: committed },
  );
  const result = patch.then(
    (entry) => ({ ok: true as const, entry }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([
      entered.promise,
      patch.then(() => {
        throw new Error("Patch settled before snapshot preparation");
      }),
    ]);
    writeSessionEntry(database, f.scope.sessionKey, {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-lifecycle",
      updatedAt: 2,
    });
    release.resolve();
    expect(await result).toMatchObject({
      ok: false,
      error: { name: "SqliteSessionMutationConflictError" },
    });
    expect(committed).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject({
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-lifecycle",
    });
    expect(f.read()?.activeWriterRunId).toBeUndefined();
  } finally {
    release.resolve();
    await result;
  }
});

it.each(["cancel", "revoke"] as const)(
  "rechecks %s at worker commit admission after asynchronous preparation",
  async (mode) => {
    const f = fixture(`worker-${mode}`);
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    const revoked = new Error("Patch authority was revoked");
    const committed = vi.fn();
    let allowed = true;
    let prepared = false;
    let refusedAtCommit = false;
    const observer = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (prepared && request.stage === "commit") {
            allowed = false;
            refusedAtCommit = true;
          }
          callback(request, grant);
        }, attachment),
      );
    try {
      const patch = patchSessionEntryCore(
        f.scope,
        async () => {
          await Promise.resolve();
          prepared = true;
          return { activeWriterRunId: "refused-run" };
        },
        {
          skipMaintenance: true,
          shouldCommit: () => mode !== "cancel" || allowed,
          assertCommitAllowed() {
            if (mode === "revoke" && !allowed) {
              throw revoked;
            }
          },
          onCommitted: committed,
        },
      );
      if (mode === "cancel") {
        await expect(patch).resolves.toBeNull();
      } else {
        await expect(patch).rejects.toBe(revoked);
      }
      expect(refusedAtCommit).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      expect(f.read()?.activeWriterRunId).toBeUndefined();
    } finally {
      observer.mockRestore();
    }
  },
);

it.each(["lost delivery", "lost receipt", "unknown native settlement"] as const)(
  "settles committed patch bookkeeping before identity publication with %s",
  async (fault) => {
    const f = fixture(`worker-${fault.replaceAll(" ", "-")}`);
    const order: string[] = [];
    const stop = onSessionIdentityMutation((change) => {
      if (change.kind !== "delete" && change.current.sessionKeys.includes(f.scope.sessionKey)) {
        order.push("published");
      }
    });
    const deliveryFailure = new Error("Patch committed but its reply was lost");
    const restoreFaults: Array<() => void> = [];
    let verifiedCommits = 0;
    const original = workerStore.runSqliteWorkerStoreOperation;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          target: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
          requireStateLifecycle?: Parameters<typeof original>[5],
        ) => {
          let patching = false;
          let injected = false;
          let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
          let nativeRetention: RetainedWorkerTransactionAdmission | undefined;
          return original(
            target,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  patching = command.type === "session.entry.patch";
                  const result = await worker.execute(command, options);
                  if (!patching) {
                    return result;
                  }
                  expect(nativeAdmission?.committed).toMatchObject({
                    facts: {
                      kind: "session-entry-replacements",
                      changedKeys: [f.scope.sessionKey],
                    },
                  });
                  const nativeSettlement = nativeAdmission?.settlement;
                  expect(nativeSettlement?.kind).toBe("completed");
                  expect(await nativeRetention?.settled).toEqual({ kind: "completed" });
                  expect(f.read()).toMatchObject({
                    activeWriterRunId: "committed-run",
                    lifecycleRevision: "committed-lifecycle",
                  });
                  if (!nativeAdmission || !nativeSettlement) {
                    throw new Error("Real patch did not provide native settlement");
                  }
                  if (fault === "lost receipt") {
                    const receipt = vi
                      .spyOn(nativeAdmission, "committed", "get")
                      .mockReturnValue(undefined);
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ kind: "completed" });
                    restoreFaults.push(
                      () => receipt.mockRestore(),
                      () => settlement.mockRestore(),
                    );
                  } else if (fault === "unknown native settlement") {
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ ...nativeSettlement, kind: "unknown" });
                    restoreFaults.push(() => settlement.mockRestore());
                  }
                  verifiedCommits++;
                  injected = true;
                  if (fault !== "unknown native settlement") {
                    throw deliveryFailure;
                  }
                  return result;
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                if (!patching) {
                  return createAdmission(retained);
                }
                nativeRetention = retained;
                const owned = createAdmission({
                  get settled() {
                    return retained.settled.then((settlement) =>
                      injected && fault === "lost delivery"
                        ? { kind: "unknown" as const, error: deliveryFailure }
                        : settlement,
                    );
                  },
                });
                nativeAdmission = owned.admission;
                return owned;
              }),
            requireStateLifecycle,
          );
        },
      );
    try {
      const outcome = await patchSessionEntryCore(
        f.scope,
        () => ({ activeWriterRunId: "committed-run", lifecycleRevision: "committed-lifecycle" }),
        {
          skipMaintenance: true,
          onCommitted(entry) {
            expect(entry).toMatchObject({
              activeWriterRunId: "committed-run",
              lifecycleRevision: "committed-lifecycle",
            });
            order.push("committed");
          },
        },
      ).then(
        (entry) => ({ ok: true as const, entry }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(verifiedCommits).toBe(1);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        throw new Error("An uncertain patch unexpectedly succeeded");
      }
      if (fault === "lost delivery") {
        expect(outcome.error).toBe(deliveryFailure);
      } else {
        expect(isSqliteWorkerError(outcome.error, "outcome-unknown")).toBe(true);
      }
      expect(order).toEqual(fault === "lost receipt" ? [] : ["committed", "published"]);
      expect(f.read()?.activeWriterRunId).toBe("committed-run");
    } finally {
      for (const restore of restoreFaults.toReversed()) {
        restore();
      }
      observer.mockRestore();
      stop();
    }
  },
);
