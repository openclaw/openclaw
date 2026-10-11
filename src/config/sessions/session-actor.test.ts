import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
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
import type { SessionActorAuthority, SessionActorOperations } from "./session-actor-contract.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor, type SessionActorTransport } from "./session-actor.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor } from "./session-input-actor.js";

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
    } finally {
      await actor.release();
    }
  });
});

/** Real transaction kernels and native receipts with publication and transport faults. */
async function withActor(
  run: (fixture: {
    actor: ReturnType<typeof createSessionActor>;
    commands: string[];
    fault: {
      reply: "normal" | "lost" | "unknown";
      workerPublicationFailure?: boolean;
      afterCommitted?: () => Promise<void>;
      drain?: Promise<void>;
      onExecuted?: () => void;
      admissionCancelled?: boolean;
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
    const fault: Parameters<typeof run>[0]["fault"] = { reply: "normal" };
    let epoch = 0;
    const lifetime = {
      assertAdmission() {
        if (fault.admissionCancelled) {
          throw new Error("Admission cancelled");
        }
      },
      assertCurrent() {},
      assertReadable() {},
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
          const held = epoch;
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
            const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
              grant();
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
              authorize(
                { stage, facts: { identity, publication } },
                { admission, retained },
                () => true,
              );
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
            captureGeneration: () => ({
              assertCurrent() {
                if (held !== epoch) {
                  throw new Error("Worker generation retired");
                }
              },
            }),
            execute,
          });
        });
      },
      async afterCommitted(outcome) {
        if (fault.afterCommitted) {
          await fault.afterCommitted();
          outcome.receipt.commandId = "detached-follow-up-copy";
          return { value: outcome.value };
        }
        return undefined;
      },
      async release() {},
    };
    const actor = createSessionActor({ target, lifetime, replica, transport });
    try {
      await run({
        actor,
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

it("rechecks receipt freshness after a synchronous authority callback before disclosure", async () => {
  await withActor(async ({ actor, nativePatch }) => {
    await actor.read(authority);
    expect(
      actor.snapshot({
        assertCurrent() {},
        authorize() {
          nativePatch(101);
        },
      }),
    ).toBeUndefined();
    await actor.read(authority);
    await expect(
      actor.read({
        assertCurrent() {},
        authorize() {
          nativePatch(102);
        },
      }),
    ).rejects.toThrow("changed before read disclosure");
    expect((await actor.read(authority)).entry?.updatedAt).toBe(102);
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
