import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
  type SqliteWorkerOperationSettlement,
} from "../../infra/sqlite-worker-operation-settlement.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { rewriteTranscriptEventRowsExact } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionActorAuthority, SessionActorOperations } from "./session-actor-contract.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor, type SessionActorTransport } from "./session-actor.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor } from "./session-input-actor.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

// mock-isolation: this transport proof does not schedule unrelated maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transport proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

it("keeps production incognito acquisition on its native owner without creating a memory actor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      env,
    };
    const sessionKey = "agent:main:dashboard:incognito-declined";
    const owner = runOpenClawAgentWriteTransaction((opened) => {
      writeSessionEntry(opened, sessionKey, {
        sessionId: "native-session",
        updatedAt: 1,
        incognito: true,
      });
      return opened;
    }, database);
    const actor = await acquireSessionInputActor(
      {
        agentId: database.agentId,
        storePath: database.path,
        env,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      },
      { assertCurrent() {}, assertReadable() {} },
    );
    expect(actor).toBeUndefined();
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(database)).toBe(owner);
    expect(readExactSessionEntryRow(owner, sessionKey)?.entry).toMatchObject({
      sessionId: "native-session",
      updatedAt: 1,
      incognito: true,
    });
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  });
});

it("acquires the exact cold durable execution owner and installs a real worker commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const identity = readOpenClawAgentDatabaseIdentity(fixture.database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires durable storage");
    }
    const factory = createDurableSessionActorFactory({
      agentId: "main",
      path: fixture.database.path,
      env,
    });
    const actor = await factory.acquire(
      {
        sessionKey: fixture.scope.sessionKey,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: fixture.database.path,
        },
      },
      { assertCurrent() {}, assertReadable() {} },
    );
    if ("kind" in actor) {
      throw new Error("Durable session must be actor-owned");
    }
    try {
      const result = await actor.patch(
        {
          commandId: "durable",
          phaseId: "turn",
          reducers: [{ kind: "activity", updatedAt: 543 }],
        },
        authority,
      );
      expect(result.kind).toBe("committed");
      expect(actor.snapshot(authority)?.entry?.sessionId).toBe(fixture.scope.sessionId);
      expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(543);
      expect(fixture.read()?.updatedAt).toBe(543);
      const before = actor.snapshot(authority)!;
      await patchSessionEntryCore(
        {
          agentId: "main",
          storePath: fixture.database.path,
          sessionKey: fixture.scope.sessionKey,
          env,
        },
        () => ({ label: "published patch" }),
        { skipMaintenance: true, preserveActivity: true },
      );
      const after = actor.snapshot(authority);
      expect(after?.entry).toMatchObject({ label: "published patch", updatedAt: 543 });
      expect(after?.transcript).toEqual(before.transcript);
      expect(after?.pendingInputs).toEqual(before.pendingInputs);
      expect(after?.version).toEqual({ ...before.version, sequence: before.version.sequence + 1 });
    } finally {
      await actor.release();
    }
  });
});

it("retains durable transcript context across lifecycle and participant changes but refreshes rewrites and resets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const answer = {
      type: "message",
      id: "answer",
      parentId: "question",
      message: { role: "assistant", content: "Original answer" },
    };
    const events = [
      { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Original question" },
      },
      answer,
    ];
    await replaceTranscriptEvents(scope, events);
    const identity = readOpenClawAgentDatabaseIdentity(fixture.database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires durable storage");
    }
    const database = { agentId: "main", path: fixture.database.path, env };
    const actor = await createDurableSessionActorFactory(database).acquire(
      {
        sessionKey: scope.sessionKey,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: fixture.database.path,
        },
      },
      { assertCurrent() {}, assertReadable() {} },
    );
    if ("kind" in actor) {
      throw new Error("Durable session must be actor-owned");
    }
    const historyReads = vi.spyOn(historyLane.pool, "run");
    try {
      await actor.read(authority);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionActor: { actor, database },
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          const hydration = prepareSessionTranscriptHydration(scope, {
            maxBytes: 1024 * 1024,
            maxEvents: 100,
          });
          expect((await hydration.read()).snapshot.events).toEqual(events);
          const appended = await actor.appendToolResult(
            {
              commandId: "next-turn",
              phaseId: "turn",
              turn: {
                agentId: scope.agentId,
                sessionKey: scope.sessionKey,
                options: {
                  expectedSessionId: scope.sessionId,
                  sessionFile: "synthetic.jsonl",
                  messages: [
                    {
                      eventId: "next-question",
                      message: { role: "user", content: "Next question" },
                      now: 4,
                    },
                    {
                      eventId: "next-answer",
                      message: { role: "assistant", content: "Next answer" },
                      now: 5,
                    },
                  ],
                },
              },
            },
            authority,
          );
          expect(appended.kind).toBe("committed");
          const updateMetadata = (label: string) =>
            applySessionEntryLifecycleMutation({
              ...scope,
              skipMaintenance: true,
              upserts: [
                {
                  sessionKey: scope.sessionKey,
                  buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label }),
                },
              ],
            });
          await updateMetadata("next turn");
          expect(actor.snapshot(authority)?.entry?.label).toBe("next turn");
          historyReads.mockClear();
          const warm = await hydration.read();
          expect(warm.snapshot.events).toMatchObject([
            ...events,
            { id: "next-question", message: { role: "user", content: "Next question" } },
            { id: "next-answer", message: { role: "assistant", content: "Next answer" } },
          ]);
          expect(historyReads).not.toHaveBeenCalled();

          const expectedState = buildRestartRecoveryExpectedState(
            actor.snapshot(authority)!.entry!,
          );
          const recordAndAdopt = async (contributionCount: number) => {
            await expect(
              recordSessionParticipantInWorker(scope, {
                identity: { type: "agent", id: "helper" },
                sessionAgentId: scope.agentId,
                promptedAt: 10 + contributionCount,
              }),
            ).resolves.toBe(contributionCount === 1 ? "inserted" : "updated");
            expect(actor.snapshot(authority)).toBeUndefined();
            const adopted = await actor.adoptRun(
              {
                commandId: `participant-${contributionCount}`,
                phaseId: "turn",
                sessionId: scope.sessionId,
                expectedState,
                lifecycle: {},
                runId: `participant-${contributionCount}`,
              },
              authority,
            );
            expect(adopted.kind).toBe("committed");
            expect(actor.snapshot(authority)?.participants).toEqual([
              {
                identity: { type: "agent", id: "helper" },
                contributionCount,
                firstPromptedAt: 11,
                lastPromptedAt: 10 + contributionCount,
              },
            ]);
          };
          for (const contributionCount of [1, 2]) {
            await recordAndAdopt(contributionCount);
            historyReads.mockClear();
            expect((await hydration.read()).snapshot.events).toEqual(warm.snapshot.events);
            expect(historyReads).not.toHaveBeenCalled();
          }

          const row = readTranscriptEventRows(fixture.database, scope.sessionId)[2]!;
          const rewrittenAnswer = {
            ...answer,
            message: { role: "assistant", content: "Corrected answer" },
          };
          await expect(
            rewriteTranscriptEventRowsExact(scope, {
              expectedGeneration: warm.snapshot.version.generation,
              rows: [{ seq: row.seq, expectedEventJson: row.eventJson, event: rewrittenAnswer }],
            }),
          ).resolves.not.toBeNull();
          await updateMetadata("after rewrite");
          expect(actor.snapshot(authority)).toBeUndefined();
          await recordAndAdopt(3);
          historyReads.mockClear();
          const refreshed = await hydration.read();
          expect(refreshed.snapshot.events).toContainEqual(rewrittenAnswer);
          expect(refreshed.snapshot.events).not.toContainEqual(answer);
          expect(historyReads).toHaveBeenCalled();

          await applySessionEntryLifecycleMutation({
            ...scope,
            skipMaintenance: true,
            upserts: [
              {
                sessionKey: scope.sessionKey,
                buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label: "after reset" }),
                resetBoundary: {
                  context: "clear",
                  reason: "reset",
                  boundaryId: "reset-boundary",
                  cwd: "/synthetic",
                },
              },
            ],
          });
          expect(actor.snapshot(authority)).toBeUndefined();
          await actor.read(authority);
          historyReads.mockClear();
          const reset = await hydration.read();
          expect(reset.snapshot.events).toContainEqual(
            expect.objectContaining({ type: "reset", id: "reset-boundary", reason: "reset" }),
          );
          expect(historyReads).toHaveBeenCalled();
        },
      );
    } finally {
      historyReads.mockRestore();
      await actor.release();
    }
  });
});

/** Real transaction kernels and native receipts with publication and transport faults. */
async function withActor(
  run: (fixture: {
    actor: ReturnType<typeof createSessionActor>;
    commands: string[];
    admissions: SqliteWorkerAdmissionRequest[];
    fault: {
      reply: "normal" | "lost" | "unknown";
      workerPublicationFailure?: boolean;
      afterCommitted?: () => Promise<void>;
      drain?: Promise<void>;
      onExecuted?: () => void;
      admissionCancelled?: boolean;
      disclosureRevoked?: boolean;
    };
    retireGeneration(this: void): void;
    nativePatch(this: void, updatedAt: number): void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const database = fixture.database;
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires durable storage");
    }
    const target = {
      sessionKey: fixture.scope.sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
    const options = { agentId: "main", path: database.path };
    const commands: string[] = [];
    const admissions: SqliteWorkerAdmissionRequest[] = [];
    const fault: Parameters<typeof run>[0]["fault"] = { reply: "normal" };
    let epoch = 0;
    const lifetime = {
      assertAdmission() {
        if (fault.admissionCancelled) {
          throw new Error("Admission cancelled");
        }
      },
      assertCurrent() {},
      assertReadable() {
        if (fault.disclosureRevoked) {
          throw new Error("Snapshot disclosure revoked");
        }
      },
    };
    const replica = createSessionActorReplica({
      target,
      lifetime,
      currentGeneration: () => `fixture:${epoch}`,
    });
    let admit: (stage: "transaction" | "commit", publication?: unknown) => void = () => {
      throw new Error("No active transport admission");
    };
    const createKernel = () =>
      createSessionActorWorker(
        {
          options,
          open: () => database,
          admit: (stage, publication) => admit(stage, publication),
          writeTransaction: (_label, _owner, write) => {
            const result = runOpenClawAgentWriteTransaction(write, options);
            if (fault.workerPublicationFailure) {
              throw new Error("Worker publication failed");
            }
            return result;
          },
        },
        () => target.database,
      );
    let kernel = createKernel();
    const transport: SessionActorTransport = {
      run(operation, authorize) {
        return runOpenClawAgentWorkerWrite(options, async () => {
          async function execute<Key extends keyof SessionActorOperations>(command: {
            type: Key;
            input: SessionActorOperations[Key]["input"];
          }): Promise<SessionActorOperations[Key]["output"]>;
          async function execute(
            command: SqliteWorkerCommand<SessionActorOperations>,
          ): Promise<SessionActorOperations[keyof SessionActorOperations]["output"]> {
            commands.push(command.type);
            const completion = Promise.withResolvers<SqliteWorkerOperationSettlement>();
            const retained = { settled: completion.promise };
            const admission = createSqliteWorkerOperationAdmission((request, grant) => {
              admissions.push(request);
              authorize(request, { admission, retained }, grant);
            });
            const dropped = fault.reply === "unknown";
            const postMessage = admission.port.postMessage.bind(admission.port);
            const wire = vi
              .spyOn(admission.port, "postMessage")
              .mockImplementation((message, transferList) => {
                if (
                  dropped &&
                  isRecord(message) &&
                  (message.kind === "native-commit" || message.kind === "native-settlement")
                ) {
                  return;
                }
                postMessage(message, transferList);
                // Native admission blocks synchronously; its host runs on this fixture's isolate.
                admission.service();
              });
            const native: SqliteWorkerOperationContext = {
              port: admission.port,
            };
            admit = (stage, publication) =>
              requestSqliteWorkerOperationAdmission({ stage, facts: { identity, publication } });
            try {
              await kernel.prepare(command);
              const value = withSqliteWorkerOperationAdmission(native, () =>
                kernel.execute(command),
              );
              const finish = () => {
                settleSqliteWorkerOperationContext(native, "completed");
                admission.service();
                completion.resolve(
                  dropped
                    ? { kind: "unknown", error: new Error("Native receipt lost") }
                    : { kind: "completed" },
                );
              };
              if (fault.drain) {
                void fault.drain.then(finish);
              } else {
                finish();
              }
              fault.onExecuted?.();
              if (fault.reply !== "normal") {
                throw new Error("Ordinary reply lost");
              }
              return value;
            } finally {
              void completion.promise.then(() => {
                wire.mockRestore();
                admission.finish();
              });
            }
          }
          return operation({
            execute,
          });
        });
      },
      async afterCommitted(outcome) {
        if (fault.afterCommitted) {
          await fault.afterCommitted();
          const copy = structuredClone(outcome);
          copy.receipt.commandId = "detached-follow-up-copy";
          return { value: copy.value };
        }
        return undefined;
      },
      async release() {},
    };
    const actor = createSessionActor({ target, lifetime, replica, transport });
    try {
      await run({
        actor,
        admissions,
        commands,
        fault,
        retireGeneration() {
          epoch += 1;
          kernel.close();
          kernel = createKernel();
        },
        nativePatch(updatedAt) {
          runOpenClawAgentWriteTransaction(
            (db) =>
              writeSessionEntry(db, fixture.scope.sessionKey, {
                ...fixture.read()!,
                updatedAt,
              }),
            options,
          );
        },
      });
    } finally {
      await actor.release();
      kernel.close();
    }
  });
}

it("serves installed state without a request and reconciles a retired worker generation", async () => {
  await withActor(async ({ actor, commands, retireGeneration }) => {
    const initial = await actor.read(authority);
    expect(actor.snapshot(authority)).toEqual(initial);
    expect(await actor.read(authority)).toEqual(initial);
    expect(commands).toEqual(["session.actor.read"]);
    retireGeneration();
    expect(actor.snapshot(authority)).toBeUndefined();
    const restored = await actor.read(authority);
    expect(restored.entry?.sessionId).toBe(initial.entry?.sessionId);
    expect(restored.version.epoch).not.toBe(initial.version.epoch);
    expect(commands).toEqual(["session.actor.read", "session.actor.read"]);
  });
});

it("installs a cold command and stale preimage without a separate read request", async () => {
  await withActor(async ({ actor, commands, fault, retireGeneration }) => {
    const input = {
      commandId: "same-command",
      phaseId: "turn",
      reducers: [{ kind: "activity" as const, updatedAt: 601 }],
    };
    const first = await actor.patch(input, authority);
    if (first.kind !== "committed") {
      throw new Error("Expected first command to adopt its current preimage");
    }
    expect(actor.snapshot(authority)).toEqual(first.receipt.postimage);
    retireGeneration();
    let revoked = false;
    fault.onExecuted = () => {
      revoked = true;
    };
    const refused = await actor.patch(
      { ...input, expected: first.receipt.afterVersion },
      {
        assertCurrent() {
          if (revoked) {
            throw new Error("Disclosure authority revoked after rollback");
          }
        },
        authorize() {},
      },
    );
    expect(refused).toMatchObject({
      kind: "rolled-back",
      error: { message: "Disclosure authority revoked after rollback" },
    });
    expect(actor.snapshot(authority)).toBeUndefined();
    delete fault.onExecuted;
    const stale = await actor.patch({ ...input, expected: first.receipt.afterVersion }, authority);
    if (stale.kind !== "stale-version") {
      throw new Error("Expected the retired worker version to be stale");
    }
    expect(stale.postimage.entry?.updatedAt).toBe(601);
    expect(actor.snapshot(authority)).toEqual(stale.postimage);
    const next = await actor.patch(
      {
        ...input,
        expected: stale.postimage.version,
        reducers: [{ kind: "activity", updatedAt: 602 }],
      },
      authority,
    );
    expect(next.kind).toBe("committed");
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(602);
    expect(commands).toEqual([
      "session.actor.patch",
      "session.actor.patch",
      "session.actor.patch",
      "session.actor.patch",
    ]);
  });
});

it("installs the full append receipt and releases FIFO before retained follow-up work", async () => {
  await withActor(async ({ actor, fault }) => {
    const before = await actor.read(authority);
    fault.afterCommitted = async () => {
      expect((await actor.read(authority)).transcript.watermark.maxSeq).not.toBe(
        before.transcript.watermark.maxSeq,
      );
    };
    const result = await actor.appendTranscriptEvent(
      {
        commandId: "model-event",
        phaseId: "model",
        expected: before.version,
        sessionId: before.entry!.sessionId,
        lifecycleRevision: before.entry!.lifecycleRevision ?? null,
        eventJson: JSON.stringify({
          type: "model_change",
          id: "selected-model",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          provider: "synthetic",
          modelId: "test-model",
        }),
      },
      authority,
    );
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") {
      throw new Error("Expected committed append");
    }
    expect(result.receipt.commandId).toBe("model-event");
    const installed = actor.snapshot(authority);
    expect(installed).toEqual(result.receipt.postimage);
    expect(installed?.transcript.watermark.maxSeq).not.toBe(before.transcript.watermark.maxSeq);
  });
});

it("releases the writer queue across phase awaits and flushes reducers on an exceptional exit", async () => {
  await withActor(async ({ actor, commands }) => {
    await actor.read(authority);
    const continuePhase = Promise.withResolvers<void>();
    const operation = actor.withPhase("failed-phase", authority, async (phase) => {
      phase.patch([{ kind: "activity", updatedAt: 987 }]);
      await continuePhase.promise;
      throw new Error("Provider failed");
    });
    // This read must finish while the phase is suspended outside the writer queue.
    await actor.read(authority);
    continuePhase.resolve();
    await expect(operation).rejects.toThrow("Provider failed");
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(987);
    expect(commands).toEqual(["session.actor.read", "session.actor.patch"]);
  });
});

it("preserves native commit through worker publication, reply, and observer failures", async () => {
  await withActor(async ({ actor, fault }) => {
    let initial = await actor.read(authority);
    fault.workerPublicationFailure = true;
    const workerFailure = await actor.patch(
      {
        commandId: "worker-publication",
        phaseId: "turn",
        expected: initial.version,
        reducers: [{ kind: "activity", updatedAt: 122 }],
      },
      authority,
    );
    expect(workerFailure).toMatchObject({
      kind: "committed",
      failure: { message: "Worker publication failed" },
    });
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(122);
    initial = actor.snapshot(authority)!;
    fault.workerPublicationFailure = false;
    fault.reply = "lost";
    const observer = vi.fn(() => {
      throw new Error("Publication rejected");
    });
    const result = await actor.patch(
      {
        commandId: "lost",
        phaseId: "turn",
        expected: initial.version,
        reducers: [{ kind: "activity", updatedAt: 123 }],
      },
      authority,
      { committed: observer },
    );
    expect(result).toMatchObject({
      kind: "committed",
      failure: { message: "Ordinary reply lost; Publication rejected" },
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(123);
  });
});

it("shares immutable actor revisions and isolates explicit policy copies", async () => {
  await withActor(async ({ actor }) => {
    const initial = await actor.read(authority);
    expect(actor.snapshot(authority)).toBe(initial);
    expect(await actor.read(authority)).toBe(initial);
    const stages: string[] = [];
    const result = await actor.patch(
      {
        commandId: "detached-policy",
        phaseId: "turn",
        reducers: [{ kind: "activity", updatedAt: 123 }],
      },
      {
        assertCurrent() {},
        authorize(stage, snapshot) {
          stages.push(stage);
          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.entry)).toBe(true);
          expect(() => {
            snapshot.dependencySessionIds.length = 0;
          }).toThrow(TypeError);
          const copy = structuredClone(snapshot);
          if (copy.entry) {
            copy.entry.sessionId = "policy-mutated";
          }
          copy.version = { epoch: "policy-mutated", sequence: -1 };
          copy.dependencySessionIds.length = 0;
        },
      },
    );
    expect(result).toMatchObject({
      kind: "committed",
      receipt: {
        beforeVersion: initial.version,
        postimage: { entry: { sessionId: initial.entry?.sessionId, updatedAt: 123 } },
      },
    });
    expect(stages).toContain("transaction");
    expect(stages).toContain("commit");
    expect(actor.snapshot(authority)?.entry?.sessionId).toBe(initial.entry?.sessionId);
    if (result.kind !== "committed") {
      throw new Error("Expected committed actor revision");
    }
    expect(actor.snapshot(authority)).toBe(result.receipt.postimage);
    expect(actor.snapshot(authority)).not.toBe(initial);
    expect(initial.entry?.updatedAt).not.toBe(123);
  });
});

it("admits tool appends once per transaction boundary without transferring transcript indexes", async () => {
  await withActor(async ({ actor, admissions }) => {
    const initial = await actor.read(authority);
    const append = {
      kind: "message" as const,
      input: {
        scope: {
          agentId: "main",
          storePath:
            actor.target.database.kind === "file" ? actor.target.database.nativeLocation : "unused",
          sessionKey: actor.target.sessionKey,
          sessionId: initial.entry!.sessionId,
        },
        cwd: "/synthetic",
        messageJson: JSON.stringify({
          role: "toolResult",
          toolCallId: "call",
          toolName: "synthetic",
          content: [{ type: "text", text: "tool output" }],
          isError: false,
          timestamp: 1,
        }),
      },
    };
    admissions.length = 0;
    const result = await actor.appendToolResult(
      { commandId: "tool", phaseId: "turn", append },
      authority,
    );
    expect(result.kind).toBe("committed");
    expect(admissions.map(({ stage }) => stage)).toEqual(["transaction", "commit"]);
    for (const request of admissions) {
      expect(request.facts).toMatchObject({
        publication: {
          snapshot: { target: actor.target, entry: { sessionId: initial.entry!.sessionId } },
        },
      });
      const facts = isRecord(request.facts) ? request.facts.publication : undefined;
      expect(
        isRecord(facts) && isRecord(facts.snapshot) && Object.hasOwn(facts.snapshot, "transcript"),
      ).toBe(false);
    }
    const committed = actor.snapshot(authority)!;
    expect(committed.transcript.anchors.length).toBeGreaterThan(initial.transcript.anchors.length);
    const refused = await actor.appendToolResult(
      {
        commandId: "refused-tool",
        phaseId: "turn",
        append: { ...append, input: { ...append.input, freshMessageCheck: true } },
      },
      {
        assertCurrent() {},
        authorize(stage, _facts, publication) {
          if (isRecord(publication) && publication.check === "fresh") {
            throw new Error("Fresh-message authority revoked");
          }
          if (stage === "commit") {
            throw new Error("Commit authority revoked");
          }
        },
      },
    );
    expect(refused).toMatchObject({
      kind: "rolled-back",
      error: { message: "Fresh-message authority revoked" },
    });
    expect((await actor.read(authority)).transcript).toEqual(committed.transcript);
  });
});

it.each([false, true])(
  "appends prepared session-manager messages without snapshot disclosure (toolResult=%s)",
  async (toolResult) => {
    await withActor(async ({ actor, fault, admissions }) => {
      const initial = await actor.read(authority);
      const sessionId = initial.entry!.sessionId;
      fault.disclosureRevoked = true;
      expect(() => actor.snapshot(authority)).toThrow("Snapshot disclosure revoked");
      admissions.length = 0;
      const result = await appendSessionManagerActor({
        actor,
        toolResult,
        assertCurrent: () => authority.assertCurrent(),
        append: {
          kind: "message",
          input: {
            scope: {
              agentId: "main",
              storePath:
                actor.target.database.kind === "file"
                  ? actor.target.database.nativeLocation
                  : "unused",
              sessionKey: actor.target.sessionKey,
              sessionId,
            },
            cwd: "/synthetic",
            messageJson: JSON.stringify(
              toolResult
                ? {
                    role: "toolResult",
                    toolCallId: "prepared-tool",
                    toolName: "synthetic",
                    content: [{ type: "text", text: "prepared result" }],
                    isError: false,
                    timestamp: 2,
                  }
                : { role: "user", content: "prepared input", timestamp: 2 },
            ),
          },
        },
      });
      expect(result.failure).toBeUndefined();
      expect(result.committed).toMatchObject({
        kind: "message",
        value: { snapshot: { ok: true } },
      });
      expect(admissions.map(({ stage }) => stage)).toEqual(["transaction", "commit"]);
      fault.disclosureRevoked = false;
      const current = actor.snapshot(authority)!;
      expect(current.version.sequence).toBe(initial.version.sequence + 1);
      expect(current.transcript.anchors).toHaveLength(initial.transcript.anchors.length + 1);
    });
  },
);

it("retains rollback state and fences unknown commits until an explicit read", async () => {
  await withActor(async ({ actor, commands, fault }) => {
    const initial = await actor.read(authority);
    const rejected = await actor.patch(
      {
        commandId: "refused",
        phaseId: "turn",
        expected: initial.version,
        reducers: [{ kind: "activity", updatedAt: 123 }],
      },
      {
        assertCurrent() {},
        authorize(stage) {
          if (stage === "commit") {
            throw new Error("Authority revoked");
          }
        },
      },
    );
    expect(rejected.kind).toBe("rolled-back");
    const rolledBack = actor.snapshot(authority) ?? (await actor.read(authority));
    expect(rolledBack.entry?.updatedAt).toBe(initial.entry?.updatedAt);
    fault.reply = "unknown";
    const unknown = await actor.patch(
      {
        commandId: "unknown",
        phaseId: "turn",
        expected: rolledBack.version,
        reducers: [{ kind: "activity", updatedAt: 456 }],
      },
      authority,
    );
    expect(unknown.kind).toBe("unknown");
    expect(actor.snapshot(authority)).toBeUndefined();
    const before = commands.length;
    expect(
      (await actor.patch({ commandId: "unknown", phaseId: "turn", reducers: [] }, authority)).kind,
    ).toBe("unknown");
    expect(commands).toHaveLength(before);
    fault.reply = "normal";
    expect((await actor.read(authority)).entry?.updatedAt).toBe(456);
  });
});

it("release waits actual native settlement and flushes accepted phase work after an await", async () => {
  await withActor(async ({ actor, fault, commands }) => {
    const initial = await actor.read(authority);
    const continuePhase = Promise.withResolvers<void>();
    const executed = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    const released = vi.fn();
    let release: Promise<void> | undefined;
    const operation = actor.withPhase("turn", authority, async (phase) => {
      phase.patch([{ kind: "activity", updatedAt: 789 }]);
      release = actor.release().then(released);
      await continuePhase.promise;
      return phase.actor.patch(
        { commandId: "accepted", phaseId: "turn", expected: initial.version, reducers: [] },
        authority,
      );
    });
    fault.drain = drain.promise;
    fault.onExecuted = executed.resolve;
    fault.reply = "lost";
    continuePhase.resolve();
    await executed.promise;
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    drain.resolve();
    expect((await operation).kind).toBe("committed");
    await release;
    expect(commands).toEqual(["session.actor.read", "session.actor.patch"]);
    expect(released).toHaveBeenCalledOnce();
  });
});

it("refuses cancelled admission while an accepted phase settles its committed reducers", async () => {
  await withActor(async ({ actor, fault, commands }) => {
    const initial = await actor.read(authority);
    const continuePhase = Promise.withResolvers<void>();
    const operation = actor.withPhase("accepted-turn", authority, async (phase) => {
      phase.patch([{ kind: "activity", updatedAt: 790 }]);
      await continuePhase.promise;
      return phase.actor.patch(
        {
          commandId: "accepted",
          phaseId: "accepted-turn",
          expected: initial.version,
          reducers: [],
        },
        authority,
      );
    });
    fault.admissionCancelled = true;
    expect(() => actor.snapshot(authority)).toThrow("Admission cancelled");
    expect(() => actor.read(authority)).toThrow("Admission cancelled");
    expect(() => actor.withPhase("new-turn", authority, async () => {})).toThrow(
      "Admission cancelled",
    );
    expect(() =>
      actor.patch(
        { commandId: "new", phaseId: "new-turn", expected: initial.version, reducers: [] },
        authority,
      ),
    ).toThrow("Admission cancelled");
    continuePhase.resolve();
    const result = await operation;
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") {
      throw new Error("Expected accepted commit");
    }
    expect(result.receipt.postimage.entry?.updatedAt).toBe(790);
    expect(commands).toEqual(["session.actor.read", "session.actor.patch"]);
  });
});
