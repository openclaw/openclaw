import path from "node:path";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import {
  consumeSessionPendingInput,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import type {
  SessionActorHotState,
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorReceipt,
} from "./session-actor-contract.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import {
  createSessionActorReplica,
  readSessionActorRowFacts,
  retainSessionActorEntryFacts,
} from "./session-actor-replica.js";
import { createSessionActor } from "./session-actor.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

type Fixture = Parameters<Parameters<typeof withReplica>[0]>[0];

async function withReplica(
  run: (fixture: {
    replica: ReturnType<typeof createSessionActorReplica>;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    scope: { agentId: string; sessionKey: string; storePath: string; env: NodeJS.ProcessEnv };
    load: (epoch?: string, sequence?: number) => SessionActorHotState;
    reacquire: () => ReturnType<typeof createSessionActorReplica>;
    retireGeneration: () => void;
  }) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:actor-replica",
      storePath: database.path,
      env,
    };
    replaceSessionEntrySync(scope, { sessionId: "replica-session", updatedAt: 1, label: "before" });
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Replica fixture requires a durable database");
    }
    const target = {
      sessionKey: scope.sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
    let generation = 0;
    const reacquire = () =>
      createSessionActorReplica({
        target,
        lifetime: { assertCurrent() {}, assertReadable() {} },
        currentGeneration: () => `${identity.incarnation}:${generation}`,
      });
    const replica = reacquire();
    const load = (epoch = "first", sequence = 0): SessionActorHotState => {
      const writeToken = readSqliteDatabaseScopedWriteTokenForPath(
        database.path,
        collectSessionEntryLookupKeys(target.sessionKey),
      );
      if (!writeToken) {
        throw new Error("Replica fixture has an unsettled native writer");
      }
      const state = hydrateSessionActorState(database, target, { epoch, sequence }, writeToken).hot;
      state.writeToken = readSqliteDatabaseScopedWriteTokenForPath(database.path, [
        ...collectSessionEntryLookupKeys(target.sessionKey),
        ...state.dependencySessionIds.map(sqliteSessionIdWriteScope),
      ])!;
      return state;
    };
    try {
      await run({
        replica,
        database,
        scope,
        load,
        reacquire,
        retireGeneration() {
          generation += 1;
        },
      });
    } finally {
      replica.close();
    }
  });
}

function hydrate({ replica, load }: Fixture, epoch = "first", sequence = 0) {
  const selected = replica.beginRead();
  const snapshot = load(epoch, sequence);
  expect(selected.install(snapshot)).toBe(true);
  return snapshot;
}

function command(snapshot: SessionActorHotState, commandId: string) {
  return {
    commandId,
    phaseId: "turn",
    phase: "patch" as const,
    expected: snapshot.version,
  };
}

function committed(
  context: ReturnType<typeof command>,
  postimage: SessionActorHotState,
): Extract<SessionActorOutcome<undefined>, { kind: "committed" }> {
  const receipt: SessionActorReceipt = {
    kind: "session-actor-committed",
    commandId: context.commandId,
    phaseId: context.phaseId,
    phase: context.phase,
    beforeVersion: context.expected,
    afterVersion: postimage.version,
    transcript: {
      before: postimage.transcript.version,
      after: postimage.transcript.version,
      appendedMessages: [],
      projectionNeedsReconcile: false,
    },
    reducers: [],
    postimage,
  };
  return { kind: "committed", value: undefined, receipt };
}

it("returns a newer committed replica when a receipt arrives during a worker read", async () => {
  await withReplica(async ({ replica, load, scope }) => {
    const initial = load();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<SessionActorHotState>();
    const execute = vi
      .fn<SqliteWorkerStore<SessionActorOperations>["execute"]>()
      .mockReturnValue(reply.promise);
    const actor = createSessionActor({
      target: initial.target,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      replica,
      transport: {
        run: async (operation) => {
          const result = operation({
            execute,
          });
          started.resolve();
          return result;
        },
        async release() {},
      },
    });
    const publish = () => {
      const pending = replica.beginCommand();
      replaceSessionEntrySync(scope, {
        sessionId: "replica-session",
        updatedAt: 2,
        label: "after",
      });
      expect(pending.settle(committed(command(initial, "newer"), load("first", 1)))).toBe(true);
    };
    const authorize = vi.fn();
    try {
      const reading = actor.read({ assertCurrent() {}, authorize });
      await started.promise;
      publish();
      reply.resolve(initial);
      expect((await reading).entry).toMatchObject({ updatedAt: 2, label: "after" });
      expect(execute).toHaveBeenCalledOnce();
      expect(authorize).toHaveBeenLastCalledWith(
        "commit",
        expect.objectContaining({ entry: expect.objectContaining({ updatedAt: 2 }) }),
      );
    } finally {
      reply.resolve(initial);
      await actor.release();
    }
  });
});

it("shares committed facts across released handles and retires them for writes and worker loss", async () => {
  await withReplica((fixture) => {
    const first = hydrate(fixture);
    const replacement = fixture.reacquire();
    fixture.replica.close();
    try {
      expect(fixture.replica.read()).toBeUndefined();
      expect(replacement.read()).toEqual(first);
      const context = command(first, "replacement-command");
      const pending = replacement.beginCommand();
      const sibling = fixture.reacquire();
      try {
        expect(sibling.read()).toBeUndefined();
        expect(pending.settle(committed(context, fixture.load("first", 1)))).toBe(true);
        expect(sibling.read()?.version).toEqual({ epoch: "first", sequence: 1 });
        replacement.close();
        expect(sibling.read()?.version.sequence).toBe(1);
        assignSessionOwner(fixture.scope, {
          owner: { type: "agent", id: "new-owner" },
          assignedBy: { type: "agent", id: "main" },
          assignedAt: 2,
        });
        expect(sibling.read()).toBeUndefined();
        hydrate({ ...fixture, replica: sibling }, "after-write");
        expect(sibling.read()?.entry?.owner?.actor.id).toBe("new-owner");
        fixture.retireGeneration();
        const restarted = fixture.reacquire();
        try {
          expect(restarted.read()).toBeUndefined();
          expect(sibling.read()).toBeUndefined();
          hydrate({ ...fixture, replica: restarted }, "restarted");
          expect(restarted.read()?.version.epoch).toBe("restarted");
        } finally {
          restarted.close();
        }
      } finally {
        sibling.close();
      }
    } finally {
      replacement.close();
    }
  });
});

it("retains unrelated session postimages but invalidates a shared physical session window", async () => {
  await withReplica((fixture) => {
    const other = { ...fixture.scope, sessionKey: "agent:main:other-replica" };
    replaceSessionEntrySync(other, { sessionId: "other-session", updatedAt: 1, label: "other" });
    const snapshot = hydrate(fixture);
    if (snapshot.target.database.kind !== "file") {
      throw new Error("Replica fixture requires a durable target");
    }
    retainSessionActorEntryFacts(
      { ...snapshot.target, database: snapshot.target.database },
      { entry: snapshot.entry, snapshots: [] },
      "partial-entry-reader",
    );
    expect(fixture.replica.read()).toEqual(snapshot);
    replaceSessionEntrySync(other, { sessionId: "other-session", updatedAt: 2, label: "changed" });
    expect(fixture.replica.read()).toEqual(snapshot);
    using sibling = openNodeSqliteDatabase(fixture.database.path);
    withSqliteDatabaseWriteScope(
      sibling,
      [other.sessionKey, sqliteSessionIdWriteScope("other-session")],
      () =>
        runSqliteImmediateTransactionSync(sibling, () => {
          sibling
            .prepare("UPDATE session_windows SET display_name = ? WHERE session_id = ?")
            .run("sibling-window", "other-session");
        }),
    );
    expect(fixture.replica.read()).toEqual(snapshot);

    // A second logical key can point at the actor's existing physical window.
    replaceSessionEntrySync(other, { sessionId: "replica-session", updatedAt: 3, label: "shared" });
    expect(fixture.replica.read()).toBeUndefined();
    expect(
      fixture.database.db
        .prepare("SELECT display_name FROM session_windows WHERE session_id = ?")
        .get("replica-session"),
    ).toEqual({ display_name: "shared" });
    expect(hydrate(fixture).entry?.label).toBe("before");
    const shared = fixture.replica.read();
    assignSessionOwner(other, {
      owner: { type: "agent", id: "other-owner" },
      assignedBy: { type: "agent", id: "main" },
      assignedAt: 4,
    });
    // Ownership belongs to the other logical row, not its shared window.
    expect(fixture.replica.read()).toEqual(shared);
  });
});

it("invalidates partial native publications before disclosure and count-only participant writes through the shared receipt", async () => {
  await withReplica((fixture) => {
    const { replica, scope, database, load } = fixture;
    hydrate(fixture);
    const disclosures: Array<SessionActorHotState | undefined> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        disclosures.push(replica.read());
      }
    });
    try {
      addSessionMember(scope, { identityId: "reader", addedBy: "owner", addedAt: 2 });
      expect(disclosures.length).toBeGreaterThan(0);
      expect(disclosures.every((value) => value === undefined)).toBe(true);
      expect(replica.read()).toBeUndefined();
      expect(hydrate(fixture).members).toEqual([
        { identityId: "reader", addedBy: "owner", addedAt: 2 },
      ]);

      const participant = {
        identity: { type: "agent" as const, id: "helper" },
        sessionAgentId: "main",
      };
      recordSessionParticipant(scope, { ...participant, promptedAt: 3 });
      hydrate(fixture);
      expect(replica.read()?.participants[0]?.contributionCount).toBe(1);
      recordSessionParticipant(scope, { ...participant, promptedAt: 4 });
      // This writer intentionally omits a display delta for contribution-only changes.
      expect(replica.read()).toBeUndefined();
      expect(hydrate(fixture).participants[0]).toMatchObject({
        contributionCount: 2,
        lastPromptedAt: 4,
      });

      expect(() =>
        runOpenClawAgentWriteTransaction(
          (current) => {
            writeSessionEntry(current, scope.sessionKey, {
              sessionId: "replica-session",
              updatedAt: 5,
              label: "rolled back",
            });
            throw new Error("abort replica fixture");
          },
          { agentId: scope.agentId, path: database.path, env: scope.env },
        ),
      ).toThrow("abort replica fixture");
      expect(load().entry?.label).toBe("before");
      expect(hydrate(fixture).entry?.label).toBe("before");
    } finally {
      unsubscribe();
    }
  });
});

it("installs complete outcomes, fences unknowns, and rejects delayed epochs", async () => {
  await withReplica((fixture) => {
    const { replica, load, scope } = fixture;
    const initial = hydrate(fixture);
    const detached = replica.read()!;
    detached.entry!.label = "caller edit";
    expect(replica.read()?.entry?.label).toBe("before");

    const accepted = command(initial, "accepted");
    const pending = replica.beginCommand();
    expect(replica.read()).toBeUndefined();
    const outcome = committed(accepted, load("first", 1));
    expect(pending.settle(outcome)).toBe(true);
    outcome.receipt.postimage.entry!.label = "receipt caller edit";
    expect(replica.read()?.entry?.label).toBe("before");
    expect(pending.settle(outcome)).toBe(false);

    const rollback = replica.beginCommand();
    expect(
      rollback.settle({ kind: "rolled-back", error: { name: "Error", message: "refused" } }),
    ).toBe(true);
    expect(replica.read()?.version.sequence).toBe(1);
    const unknown = replica.beginCommand();
    expect(
      unknown.settle({
        kind: "unknown",
        target: initial.target,
        commandId: "unknown",
        error: { name: "Error", message: "reply lost without receipt" },
      }),
    ).toBe(false);
    expect(replica.read()).toBeUndefined();

    const stale = replica.beginCommand();
    const superseded = load("superseded");
    expect(
      stale.settle({
        kind: "stale-version",
        expected: initial.version,
        postimage: superseded,
        error: { name: "SessionActorStaleVersionError", message: "Session actor version changed" },
      }),
    ).toBe(true);
    expect(replica.read()?.version).toEqual(superseded.version);
    const older = replica.beginRead();
    const newer = replica.beginRead();
    expect(newer.install(load("second"))).toBe(true);
    expect(older.install(initial)).toBe(false);
    expect(replica.read()?.version.epoch).toBe("second");

    const delayedContext = command(load("second"), "delayed");
    const delayed = replica.beginCommand();
    sessionChanges.invalidate({
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
      factsInvalidated: true,
    });
    hydrate(fixture, "reconciled");
    expect(delayed.settle(committed(delayedContext, load("second", 1)))).toBe(false);
    expect(replica.read()?.version.epoch).toBe("reconciled");

    const current = hydrate(fixture, "final");
    const closingContext = command(current, "accepted-before-close");
    const closing = replica.beginCommand();
    replica.close();
    expect(closing.settle(committed(closingContext, load("final", 1)))).toBe(true);
    expect(replica.read()).toBeUndefined();
  });
});

it("invalidates for native owner, replacement, transcript and deletion writers", async () => {
  await withReplica((fixture) => {
    const { replica, scope, database } = fixture;
    hydrate(fixture);
    assignSessionOwner(scope, {
      owner: { type: "agent", id: "assigned" },
      assignedBy: { type: "agent", id: "main" },
      assignedAt: 10,
    });
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry?.owner?.actor.id).toBe("assigned");

    replaceSessionEntrySync(scope, {
      ...fixture.load().entry!,
      category: "work",
      archivedAt: 12,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
    });
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry).toMatchObject({
      category: "work",
      archivedAt: 12,
      restartRecoveryDeliveryRunId: "recovery-run",
    });

    const transcriptScope = { ...scope, sessionId: "replica-session" };
    expect(
      appendTranscriptEventSync(transcriptScope, { type: "proof", id: "first-event" }).ok,
    ).toBe(true);
    expect(replica.read()).toBeUndefined();
    const first = hydrate(fixture).transcript.watermark;
    expect(first.maxSeq).not.toBeNull();
    expect(
      replaceTranscriptEventsSync(transcriptScope, [{ type: "proof", id: "replacement-event" }]),
    ).toBe(true);
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).transcript.watermark).not.toEqual(first);

    runOpenClawAgentWriteTransaction(
      (current) => deleteSessionEntryRows(current, scope.sessionKey),
      {
        agentId: scope.agentId,
        path: database.path,
        env: scope.env,
      },
    );
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry).toBeUndefined();
  });
});

it("reuses list facts and invalidates summary watermarks after transcript writes", async () => {
  await withReplica((fixture) => {
    const { scope } = fixture;
    replaceSessionEntrySync(scope, {
      sessionId: "replica-session",
      updatedAt: 1,
      skillsSnapshot: { prompt: "Saved instructions", skills: [] },
      activitySummary: {
        version: 1,
        text: "No messages yet",
        updatedAt: 1,
        sessionId: "replica-session",
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    const before = hydrate(fixture);
    const target = { path: scope.storePath, sessionKey: scope.sessionKey };
    const facts = readSessionActorRowFacts(target);
    expect(before.entry?.skillsSnapshot?.prompt).toBe("Saved instructions");
    expect(facts?.entry).not.toHaveProperty("skillsSnapshot");
    expect(facts).toMatchObject({
      hasBoard: false,
      activitySummaryWatermark: { generation: null, maxSeq: null },
    });
    if (!facts) {
      throw new Error("Expected resident row facts");
    }
    facts.entry.label = "caller edit";
    expect(readSessionActorRowFacts(target)?.entry.label).toBeUndefined();

    const appended = appendTranscriptEventSync(
      { ...scope, sessionId: "replica-session" },
      { type: "proof", id: "summary-watermark" },
    );
    expect(appended.ok).toBe(true);
    expect(readSessionActorRowFacts(target)).toBeUndefined();
    const after = hydrate(fixture);
    expect(after.transcript.watermark).not.toEqual(before.transcript.watermark);
    expect(readSessionActorRowFacts(target)?.activitySummaryWatermark).toEqual(
      after.transcript.watermark,
    );
  });
});

it("invalidates pending custody for staging, promotion, terminal completion and withdrawal", async () => {
  await withReplica((fixture) => {
    const { replica, scope, database } = fixture;
    const options = { agentId: scope.agentId, path: database.path, env: scope.env };
    const mutate = (input: PendingInputMutation) =>
      mutatePendingInput(
        input,
        {
          admit() {},
          writeTransaction: (operationLabel, _owner, write) =>
            runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
        },
        () => {},
      );
    const stage = (id: string) => {
      const identity = {
        sessionKey: scope.sessionKey,
        sessionId: "replica-session",
        idempotencyKey: id,
        runId: `run-${id}`,
        requestHash: id,
        lifecycleGeneration: "lifecycle",
      };
      const expected = readPendingInput(database, {
        ...identity,
        kind: "stage",
        trackCompletion: true,
      });
      if (expected.kind !== "stage") {
        throw new Error("Expected a pending input staging snapshot");
      }
      mutate({
        ...identity,
        kind: "stage",
        expected,
        trackCompletion: true,
        inputId: id,
        messageJson: JSON.stringify({ role: "user", content: id, timestamp: 1 }),
      });
      return identity;
    };

    hydrate(fixture);
    stage("promote");
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).pendingInputs).toMatchObject([
      { input_id: "promote", state: "queued" },
    ]);
    runOpenClawAgentWriteTransaction(
      (current) =>
        consumeSessionPendingInput(current, {
          inputId: "promote",
          message: { role: "user", content: "promote", timestamp: 1 },
          alreadyPromoted: false,
        }),
      options,
    );
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).pendingInputs).toEqual([]);

    const complete = stage("complete");
    hydrate(fixture);
    mutate({ ...complete, kind: "complete", outcome: { reason: "completed", status: "ok" } });
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).pendingInputs).toEqual([]);
    expect(readSessionInputCompletion(database, complete)?.outcome).toMatchObject({
      reason: "completed",
      status: "ok",
    });

    const withdraw = stage("withdraw");
    hydrate(fixture);
    mutate({ ...withdraw, kind: "finish", inputId: "withdraw", disposition: "cancelled" });
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).pendingInputs).toMatchObject([
      { input_id: "withdraw", state: "cancelled" },
    ]);
  });
});

it("retires hot facts across the released SDK and restart delivery owners", async () => {
  await withReplica(async (fixture) => {
    const { scope, replica } = fixture;
    replaceSessionEntrySync(scope, {
      ...fixture.load().entry!,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    });
    hydrate(fixture);
    await expect(
      patchSdkSessionEntry({
        ...scope,
        skipMaintenance: true,
        update: () => ({ label: "sdk label" }),
      }),
    ).resolves.toMatchObject({ label: "sdk label" });
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry).toMatchObject({
      label: "sdk label",
      restartRecoveryDeliveryRunId: "recovery-run",
    });

    const delivery = {
      ...scope,
      sessionId: "replica-session",
      sourceTurnId: "source-run",
      toolCallId: "synthetic-delivery",
    };
    await expect(beginRestartRecoveryTerminalDelivery(delivery)).resolves.toBe("started");
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry?.restartRecoveryDeliveryReceiptState).toBe("terminal-pending");
    await expect(completeRestartRecoveryTerminalDelivery(delivery)).resolves.toBe("recorded");
    expect(replica.read()).toBeUndefined();
    expect(hydrate(fixture).entry?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
  });
});

it("retires a resident session when native maintenance archives it", async () => {
  await withReplica(async (fixture) => {
    const { scope, replica, database } = fixture;
    const preservation = await prepareSessionMaintenancePreservation(scope.storePath);
    try {
      hydrate(fixture);
      const result = runOpenClawAgentWriteTransaction(
        (current) =>
          applySessionEntryMaintenance(current, {
            storePath: scope.storePath,
            archiveDirectory: path.join(path.dirname(scope.storePath), "archives"),
            forceMaintenance: true,
            preservation: preservation.capture,
            maintenanceConfig: {
              ...resolveMaintenanceConfigFromInput(),
              mode: "enforce",
              pruneAfterMs: 1,
              archiveDashboardAfterMs: null,
              preserveRecentMs: null,
            },
          }),
        { agentId: scope.agentId, path: database.path, env: scope.env },
      );
      expect(result.archived).toBe(1);
      expect(replica.read()).toBeUndefined();
      expect(hydrate(fixture).entry).toMatchObject({
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
    } finally {
      preservation.dispose();
    }
  });
});
