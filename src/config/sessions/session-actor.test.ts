import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainPreparedSessionEntryPredicate } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { observeSessionEntryMaintenanceAgeChanges } from "./session-accessor.sqlite-maintenance-age.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorCommandContext,
} from "./session-actor-contract.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";
import { withActor } from "./session-actor-transport.test-support.js";
import { seedSessionActorOutcomeTransferEntry } from "./session-actor-worker.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor } from "./session-input-actor.js";

// mock-isolation: this transport proof does not schedule unrelated maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transport proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const activity = (
  commandId: string,
  updatedAt: number,
  context: Partial<SessionActorCommandContext> = {},
): Parameters<SessionActor["patch"]>[0] => ({
  commandId,
  phaseId: "turn",
  reducers: [{ kind: "activity", updatedAt }],
  ...context,
});
const messageAppend = (actor: SessionActor, sessionId: string, message: unknown) => ({
  kind: "message" as const,
  input: {
    scope: {
      agentId: "main",
      storePath:
        actor.target.database.kind === "file" ? actor.target.database.nativeLocation : "unused",
      sessionKey: actor.target.sessionKey,
      sessionId,
    },
    cwd: "/synthetic",
    messageJson: JSON.stringify(message),
  },
});

it("publishes actor initialization from its absent transaction preimage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const identity = readOpenClawAgentDatabaseIdentity(fixture.database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires durable storage");
    }
    const scope = {
      ...fixture.scope,
      sessionKey: "agent:main:actor-first-maintenance",
      sessionId: "actor-first-maintenance",
    };
    const actor = await createDurableSessionActorFactory({
      agentId: "main",
      path: fixture.database.path,
      env,
    }).acquire(
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
    const ageChanges = vi.fn();
    const stopAgeChanges = observeSessionEntryMaintenanceAgeChanges(identity.identity, ageChanges);
    try {
      const result = await appendSessionManagerActor({
        actor,
        toolResult: false,
        assertCurrent() {},
        append: {
          kind: "message",
          input: {
            scope,
            cwd: "/synthetic",
            messageJson: JSON.stringify({ role: "user", content: "first input", timestamp: 2 }),
          },
          initialization: { scope, entry: { sessionId: scope.sessionId, updatedAt: 2 } },
        },
      });
      expect(result.failure).toBeUndefined();
      expect(result.committed).toMatchObject({
        kind: "message",
        value: { snapshot: { ok: true } },
      });
      expect(ageChanges).toHaveBeenCalledExactlyOnceWith({
        sessionKey: scope.sessionKey,
        entry: expect.objectContaining({ sessionId: scope.sessionId }),
        previousEntry: undefined,
      });
    } finally {
      stopAgeChanges();
      await actor.release();
    }
  });
});

it("acquires existing incognito input from memory without opening a database", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      env,
    };
    const sessionKey = "agent:main:dashboard:incognito-actor";
    const scope = { ...database, storePath: database.path, sessionKey };
    const target = { ...scope, target: { canonicalKey: sessionKey, storeKeys: [sessionKey] } };
    const lifetime = { assertCurrent() {}, assertReadable() {} };
    expect(await acquireSessionInputActor(target, lifetime)).toBeUndefined();
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    const created = await acquireSessionActorStorage(scope, { lifetime, authority, create: true });
    expect(created).toBeDefined();
    try {
      await created!.actor.storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: { sessionId: "memory-session", updatedAt: 1, incognito: true },
          },
        },
        authority,
      );
      const acquired = await acquireSessionInputActor(target, lifetime);
      expect(acquired?.actor.target.database.kind).toBe("memory");
      try {
        expect(acquired?.actor.snapshot(authority)?.entry?.sessionId).toBe("memory-session");
      } finally {
        await acquired?.actor.release();
      }
      expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
    } finally {
      await created?.actor.release();
      memorySessionActorOwners.closeDatabase(database);
    }
  });
});

it.each([false, true])(
  "acquires the exact cold durable execution owner and installs a real worker commit (oversized=%s)",
  async (oversized) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const fixture = createSessionCompoundWorkerFixture();
      if (oversized) {
        seedSessionActorOutcomeTransferEntry(fixture);
      }
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
      const ageChanges = vi.fn();
      const stopAgeChanges = observeSessionEntryMaintenanceAgeChanges(
        identity.identity,
        ageChanges,
      );
      try {
        const beforeEntry = fixture.read();
        const revoked = await actor.patch(
          activity("durable-revoked-transfer", 542, { phaseId: "transfer-revocation" }),
          {
            assertCurrent() {},
            authorize(stage) {
              if (stage === "commit") {
                throw new Error("synthetic live authority revocation");
              }
            },
          },
        );
        expect(revoked).toMatchObject({
          kind: "rolled-back",
          error: { message: "synthetic live authority revocation" },
        });
        expect(fixture.read()).toEqual(beforeEntry);
        expect(ageChanges).not.toHaveBeenCalled();

        const retained = retainPreparedSessionEntryPredicate({
          databaseIdentity: `file:${identity.identity}`,
          sessionKey: fixture.scope.sessionKey,
          entry: fixture.read(),
          matches: (before, after) => before?.updatedAt === after?.updatedAt,
        });
        using _ = { [Symbol.dispose]: retained.release };
        const result = await actor.patch(activity("durable", 543), authority, {
          committed: () => {
            expect(retained.isCurrent()).toBe(false);
            expect(ageChanges).toHaveBeenCalledExactlyOnceWith({
              sessionKey: fixture.scope.sessionKey,
              entry: expect.objectContaining({ updatedAt: 543 }),
              previousEntry: expect.objectContaining({ updatedAt: beforeEntry?.updatedAt }),
            });
          },
        });
        expect(result.kind).toBe("committed");
        assert(result.kind === "committed");
        expect(result.receipt.postimage.transcript.idempotency).toEqual([]);
        expect(result.receipt.postimage.transcript.anchors).toEqual([]);
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
        if (oversized) {
          // Optional actor postimages exceeding the entry-publication envelope invalidate the replica.
          expect(actor.snapshot(authority)).toBeUndefined();
        }
        const after = oversized ? await actor.read(authority) : actor.snapshot(authority);
        expect(after?.entry).toMatchObject({ label: "published patch", updatedAt: 543 });
        expect(after?.transcript).toEqual(before.transcript);
        expect(after?.pendingInputs).toEqual(before.pendingInputs);
        expect(after?.version).toEqual({
          ...before.version,
          sequence: before.version.sequence + 1,
        });
      } finally {
        stopAgeChanges();
        await actor.release();
      }
    });
  },
);

it("recovers a transferred native commit after ordinary reply loss without replay", async () => {
  await withActor(async ({ actor, commands, fault, seedTransferEntry, readEntry }) => {
    seedTransferEntry();
    fault.reply = "lost";
    const result = await actor.patch(
      activity("lost-transfer-reply", 600, { phaseId: "activity" }),
      authority,
    );
    expect(result).toMatchObject({
      kind: "committed",
      failure: { origin: "response", message: "Ordinary reply lost" },
    });
    assert(result.kind === "committed");
    expect(result.receipt.postimage.entry?.skillsSnapshot?.prompt.length).toBeGreaterThan(
      1024 * 1024,
    );
    expect(commands).toEqual(["session.actor.patch"]);
    expect(readEntry()?.updatedAt).toBe(600);
    fault.settlementLost = true;
    const retained = await actor.patch(
      activity("lost-transfer-settlement", 602, { phaseId: "activity" }),
      authority,
    );
    expect(retained).toMatchObject({
      kind: "committed",
      failure: { origin: "response", message: "Ordinary reply lost" },
    });
    expect(commands).toEqual(["session.actor.patch", "session.actor.patch"]);
    expect(readEntry()?.updatedAt).toBe(602);
  });
});

it("does not publish a candidate when its outcome transfer is incomplete", async () => {
  await withActor(async ({ actor, commands, fault, seedTransferEntry, readEntry }) => {
    seedTransferEntry();
    const before = readEntry();
    fault.incompleteOutcomeTransfer = true;
    const observer = { committed: vi.fn() };
    const result = await actor.patch(
      activity("incomplete-transfer", 601, { phaseId: "activity" }),
      authority,
      observer,
    );
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { message: "Synthetic incomplete actor outcome transfer" },
    });
    expect(readEntry()).toEqual(before);
    expect(observer.committed).not.toHaveBeenCalled();
    expect(commands).toEqual(["session.actor.patch"]);
  });
});

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

it.each(["updated", "caller revoked", "disclosure revoked", "keeps changing"] as const)(
  "reconciles a cold actor read superseded by a native publication (%s)",
  async (change) => {
    await withActor(async ({ actor, commands, fault, nativePatch }) => {
      let callerRevoked = false;
      const readAuthority: SessionActorAuthority = {
        assertCurrent() {
          if (callerRevoked) {
            throw new Error("Read caller revoked");
          }
        },
        authorize() {},
      };
      fault.onExecuted = () => {
        if (change !== "keeps changing") {
          fault.onExecuted = undefined;
        }
        nativePatch(654 + commands.length);
        callerRevoked = change === "caller revoked";
        fault.disclosureRevoked = change === "disclosure revoked";
      };
      const reading = actor.read(readAuthority);
      if (change === "updated") {
        await expect(reading).resolves.toMatchObject({ entry: { updatedAt: 655 } });
        expect(commands).toEqual(["session.actor.read", "session.actor.read"]);
      } else if (change === "keeps changing") {
        await expect(reading).rejects.toThrow(
          "Session actor changed before its read could publish",
        );
        expect(commands).toEqual(["session.actor.read", "session.actor.read"]);
      } else {
        await expect(reading).rejects.toThrow(
          change === "caller revoked" ? "Read caller revoked" : "Snapshot disclosure revoked",
        );
        expect(commands).toEqual(["session.actor.read"]);
      }
    });
  },
);

it("installs a cold command and stale preimage without a separate read request", async () => {
  await withActor(async ({ actor, commands, fault, retireGeneration }) => {
    const input = {
      commandId: "same-command",
      phaseId: "turn",
      reducers: [{ kind: "activity" as const, updatedAt: 601 }],
    };
    const first = await actor.patch(input, authority);
    assert(first.kind === "committed");
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
    assert(stale.kind === "stale-version");
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

it("keeps concurrent commands in FIFO order across a rolled-back mutation", async () => {
  await withActor(async ({ actor, readEntry }) => {
    const initial = await actor.read(authority);
    const preimages = new Map<number, number | undefined>();
    const patch = (updatedAt: number, reject = false) =>
      actor.patch(
        {
          commandId: `concurrent-${updatedAt}`,
          phaseId: "turn",
          reducers: [{ kind: "activity", updatedAt }],
        },
        {
          assertCurrent() {},
          authorize(stage, snapshot) {
            if (stage === "transaction" && !preimages.has(updatedAt)) {
              preimages.set(updatedAt, snapshot.entry?.updatedAt);
            }
            if (stage === "commit" && reject) {
              throw new Error("Concurrent command rejected");
            }
          },
        },
      );
    const [first, rejected, last] = await Promise.all([patch(601), patch(602, true), patch(603)]);
    expect(rejected).toMatchObject({
      kind: "rolled-back",
      error: { message: "Concurrent command rejected" },
    });
    if (first.kind !== "committed" || last.kind !== "committed") {
      throw new Error("Expected adjacent concurrent commands to commit");
    }
    expect(first.receipt.beforeVersion).toEqual(initial.version);
    expect(first.receipt.postimage.entry?.updatedAt).toBe(601);
    expect([...preimages]).toEqual([
      [601, initial.entry?.updatedAt],
      [602, 601],
      [603, 601],
    ]);
    expect(last.receipt.afterVersion.sequence).toBe(last.receipt.beforeVersion.sequence + 1);
    expect(actor.snapshot(authority)).toEqual(last.receipt.postimage);
    expect(readEntry()?.updatedAt).toBe(603);
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
    assert(result.kind === "committed");
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
      activity("worker-publication", 122, { expected: initial.version }),
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
      activity("lost", 123, { expected: initial.version }),
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

it("shares actor revisions and isolates explicit policy copies", async () => {
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
    const append = messageAppend(actor, initial.entry!.sessionId, {
      role: "toolResult",
      toolCallId: "call",
      toolName: "synthetic",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: 1,
    });
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
    expect(committed.transcript.version.rawSeq).toBeGreaterThan(
      initial.transcript.version.rawSeq ?? -1,
    );
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
        append: messageAppend(
          actor,
          sessionId,
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
      expect(current.transcript.version.rawSeq).toBeGreaterThan(
        initial.transcript.version.rawSeq ?? -1,
      );
    });
  },
);

it("retains rollback state and fences unknown commits until an explicit read", async () => {
  await withActor(async ({ actor, commands, fault }) => {
    const initial = await actor.read(authority);
    if (actor.target.database.kind !== "file") {
      throw new Error("Fixture requires durable storage");
    }
    const retained = retainPreparedSessionEntryPredicate({
      databaseIdentity: `file:${actor.target.database.physicalIdentity}`,
      sessionKey: actor.target.sessionKey,
      entry: initial.entry,
      matches: (before, after) => before?.sessionId === after?.sessionId,
    });
    using _ = { [Symbol.dispose]: retained.release };
    const rejected = await actor.patch(activity("refused", 123, { expected: initial.version }), {
      assertCurrent() {},
      authorize(stage) {
        if (stage === "commit") {
          throw new Error("Authority revoked");
        }
      },
    });
    expect(rejected.kind).toBe("rolled-back");
    const rolledBack = actor.snapshot(authority) ?? (await actor.read(authority));
    expect(rolledBack.entry?.updatedAt).toBe(initial.entry?.updatedAt);
    expect(retained.isCurrent()).toBe(true);
    fault.reply = "unknown";
    const unknown = await actor.patch(
      activity("unknown", 456, { expected: rolledBack.version }),
      authority,
    );
    expect(unknown.kind).toBe("unknown");
    expect(retained.isCurrent()).toBe(false);
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
    assert(result.kind === "committed");
    expect(result.receipt.postimage.entry?.updatedAt).toBe(790);
    expect(commands).toEqual(["session.actor.read", "session.actor.patch"]);
  });
});
