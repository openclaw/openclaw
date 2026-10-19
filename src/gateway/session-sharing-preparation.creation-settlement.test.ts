import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { expect, it as baseIt, vi } from "vitest";
import { readAgentDeleteDatabaseRegistry } from "../agents/agent-delete-databases.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createSessionEntryWithTranscript,
  prepareSessionEntryMutationDatabases,
} from "../config/sessions/session-accessor.entry-mutation.js";
import { publishSessionEntryCacheInvalidation } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readTranscriptStorageRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, use),
});

const prepareMissing = (cfg: OpenClawConfig, sessionKey: string) =>
  prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main", allowMissing: true });

it.for(["planning", "settlement"] as const)(
  "creates an unchanged agent session during another agent's creation and deletion %s",
  async (phase, { state }) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const temporary = openOpenClawAgentDatabase({ agentId: "temporary-before" });
    const sessionKey = "agent:main:unchanged-reload";
    const scope = { agentId: "main", storePath: database.path, sessionKey };
    await using storagePreparation = prepareSessionEntryMutationDatabases(
      [{ scope, assertCurrent: () => {} }],
      Promise.resolve(),
    );
    const storage = await storagePreparation.preparations[0]!;
    const run = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
    let overlapped = false;
    const discovery = vi
      .spyOn(targetDiscoveryLane.pool, "run")
      .mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (!overlapped) {
          overlapped = true;
          openOpenClawAgentDatabase({ agentId: "temporary-after" });
          if (phase === "planning") {
            await readAgentDeleteDatabaseRegistry({ env: state.env });
          } else {
            await withAgentDeletion(
              temporary.agentId,
              async (begin) => {
                const deletion = await begin({
                  agentId: temporary.agentId,
                  agentDir: path.dirname(temporary.path),
                  workspaceDir: state.statePath("temporary-workspace"),
                  sessionsDir: state.statePath("agents", temporary.agentId, "sessions"),
                });
                await closeOpenClawAgentDatabaseByPathAsync(temporary.path, temporary.agentId);
                rmSync(temporary.path);
                await deletion.finish({ unregisterDatabases: true });
              },
              { env: state.env },
            );
          }
        }
        return reply;
      });
    let releasePrepared: (() => void) | undefined;
    try {
      const prepared = await prepareMissing(cfg, sessionKey);
      releasePrepared = prepared.release;
      expect(overlapped).toBe(true);
      expect(prepared.readCurrent(cfg).target).toBeNull();
      const created = await createSessionEntryWithTranscript(
        scope,
        () => ({ ok: true, entry: { sessionId: "unchanged-reload-session", updatedAt: 1 } }),
        { bindCreation: prepared.bindCreation, commitGuard: () => storage.assertCurrent() },
      );
      expect(created).toMatchObject({ ok: true });
      expect(prepared.readCurrent(cfg).target?.entry.sessionId).toBe("unchanged-reload-session");
      runOpenClawAgentWriteTransaction(
        (current) =>
          writeSessionEntry(current, sessionKey, {
            ...readExactSessionEntryRow(current, sessionKey)!.entry,
            updatedAt: 2,
          }),
        { agentId: "main", path: database.path },
      );
      expect(prepared.readCurrent(cfg).target?.entry.updatedAt).toBe(2);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.sessionId).toBe(
        "unchanged-reload-session",
      );
      expect(readTranscriptStorageRows(database, "unchanged-reload-session")).toHaveLength(1);
    } finally {
      releasePrepared?.();
      discovery.mockRestore();
    }
  },
);

it.for([
  { native: "completed", broker: "unknown" },
  { native: "unknown", broker: "unknown" },
  { native: "missing", broker: "completed" },
] as const)(
  "publishes a committed creation with native $native and broker $broker settlement",
  async ({ native, broker }, { state }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: database.path },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:unknown-header";
    const sessionId = "committed-unknown-header";
    const scope = { agentId: "main", storePath: database.path, sessionKey };
    await using storagePreparation = prepareSessionEntryMutationDatabases(
      [{ scope, assertCurrent: () => {} }],
      Promise.resolve(),
    );
    const storage = await storagePreparation.preparations[0]!;
    const prepared = await prepareMissing(cfg, sessionKey);
    const observed: unknown[] = [];
    // Observe after the prepared reader, while creation custody is still active.
    const stop = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        change.storePath === database.path
      ) {
        try {
          observed.push(prepared.readCurrent(cfg).target);
        } catch (error) {
          observed.push(error);
        }
      }
    });
    const deliveryFailure = new Error("Committed creation reply was lost");
    let creations = 0;
    const restoreSettlements: Array<() => void> = [];
    const original = workerStore.runSqliteWorkerStoreOperation;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation((target, operation, stateContext, assertCurrent, createAdmission) => {
        let initializing = false;
        let admission: SqliteWorkerOperationAdmission | undefined;
        return original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                initializing = command.type === "session.entries.replace";
                const result = await worker.execute(command, options);
                if (initializing) {
                  assert(admission, "Creation command did not retain its real admission");
                  // Drain the real receipt before reading or faulting native settlement.
                  const committed = admission.committed;
                  assert(committed, "Creation command did not retain its real COMMIT receipt");
                  expect(committed.facts).toMatchObject({
                    kind: "session-entry-replacements",
                    changedKeys: [sessionKey],
                    pendingArchiveRecovery: false,
                  });
                  expect(admission.settlement?.kind).toBe("completed");
                  if (native !== "completed") {
                    const fault = vi
                      .spyOn(admission, "settlement", "get")
                      .mockReturnValue(
                        native === "unknown" ? { kind: "unknown", committed } : undefined,
                      );
                    restoreSettlements.push(() => fault.mockRestore());
                  }
                  creations++;
                  throw deliveryFailure;
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission &&
            ((retained) => {
              const admitted = createAdmission(
                initializing
                  ? {
                      settled: retained.settled.then((outcome) => {
                        expect(outcome.kind).toBe("completed");
                        return broker === "unknown"
                          ? { kind: "unknown" as const, error: deliveryFailure }
                          : outcome;
                      }),
                    }
                  : retained,
              );
              if (initializing) {
                admission = admitted.admission;
              }
              return admitted;
            }),
        );
      });
    try {
      expect(prepared.readCurrent(cfg).target).toBeNull();
      const creation = createSessionEntryWithTranscript(
        scope,
        () => ({ ok: true, entry: { sessionId, updatedAt: 1 } }),
        { bindCreation: prepared.bindCreation, commitGuard: () => storage.assertCurrent() },
      );
      if (native === "completed") {
        await expect(creation).rejects.toBe(deliveryFailure);
      } else {
        await expect(creation).rejects.toSatisfy((error: unknown) =>
          isSqliteWorkerError(error, "outcome-unknown"),
        );
      }
      expect(creations).toBe(1);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ entry: { sessionId, updatedAt: 1 } });
    } finally {
      observer.mockRestore();
      for (const restore of restoreSettlements) {
        restore();
      }
      stop();
      prepared.release();
    }
    const header = readTranscriptStorageRows(database, sessionId);
    expect(header).toHaveLength(1);
    expect(JSON.parse(header[0]!.eventJson)).toMatchObject({ type: "session", id: sessionId });
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.sessionId).toBe(sessionId);
    const fresh = await prepareMissing(cfg, sessionKey);
    try {
      expect(fresh.readCurrent(cfg).target?.entry.sessionId).toBe(sessionId);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.sessionId).toBe(sessionId);
      expect(readTranscriptStorageRows(database, sessionId)).toEqual(header);
    } finally {
      fresh.release();
    }
  },
);

it.for(["metadata", "reset-aba", "unknown", "retirement"] as const)(
  "retains sharing acquisition across %s while database admission waits",
  async (change, { state }) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    const sessionKey = "agent:main:sharing-admission";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const entry = {
      sessionId: "admission-session",
      lifecycleRevision: "original",
      updatedAt: 1,
    };
    runOpenClawAgentWriteTransaction((database) => writeSessionEntry(database, sessionKey, entry), {
      agentId: "main",
      path: storePath,
    });
    const ready = createDeferredCore();
    const pending = prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      storageReady: ready.promise,
    });
    try {
      if (change === "retirement") {
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      } else {
        runOpenClawAgentWriteTransaction(
          (database) => {
            if (change === "unknown") {
              publishSessionEntryCacheInvalidation(database, { sessionKey });
            } else if (change === "reset-aba") {
              writeSessionEntry(database, sessionKey, { ...entry, lifecycleRevision: "reset" });
              writeSessionEntry(database, sessionKey, entry);
            } else {
              writeSessionEntry(database, sessionKey, { ...entry, updatedAt: 2 });
            }
          },
          { agentId: "main", path: storePath },
        );
      }
      ready.resolve();
      if (change === "metadata") {
        const read = await pending;
        try {
          expect(read.readCurrent(cfg).target).toMatchObject({
            storeKey: sessionKey,
            entry: { ...entry, updatedAt: 2 },
          });
        } finally {
          read.release();
        }
      } else {
        await expect(pending).rejects.toThrow(
          "Session access facts are unavailable; retry after session storage is ready.",
        );
      }
    } finally {
      ready.resolve();
      await pending.then(
        (read) => read.release(),
        () => {},
      );
    }
  },
);
