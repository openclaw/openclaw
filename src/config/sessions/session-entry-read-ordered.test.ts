import { expect } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { entryFixture, test } from "./session-entry-fixture.test-support.js";
import { readRetainedSessionEntryFacts } from "./session-entry-read-facts.js";
import {
  readSessionEntriesFromStoreInWorker,
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
  withSessionStoreReaderInWorker,
} from "./session-entry-read-runtime.js";
import {
  addSessionMemberInWorker,
  recordSessionParticipantInWorker,
  removeSessionMemberInWorker,
} from "./session-sharing-store.async.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
test("returns immutable exact reads and hides internal entries from lists", async ({ store }) => {
  store.replace();
  const other = entryFixture(store.env, "other", "other");
  other.replace({ sessionId: "other-store" });
  expect((await other.entry())?.sessionId).toBe("other-store");
  const repeated = await store.read();
  expect(repeated.entries[0]?.entry.sessionId).toBe("original");
  expect(() => {
    repeated.entries[0]!.entry.sessionId = "caller-mutated";
  }).toThrow(TypeError);
  expect((await store.read()).entries[0]?.entry.sessionId).toBe("original");
  const internal = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden" });
  writeSessionEntry(store.database, internal.sessionKey, {
    sessionId: internal.sessionId,
    updatedAt: 1,
  });
  const readInternal = (projection?: "list") =>
    store.read({ sessionKeys: [internal.sessionKey], projection });
  expect((await readInternal()).entries[0]?.entry.sessionId).toBe(internal.sessionId);
  expect((await readInternal("list")).entries).toEqual([]);
});

test("retires cached lifecycle and runtime targets on replacement", async ({ store }) => {
  const { scope, input, sessionKey, options: owner, read, entry } = store;
  const runtimeTarget = { agentId: "logical", sessionId: "original", sessionKey };
  const request = {
    sessionKeys: [sessionKey],
    lifecycleSessionKey: sessionKey,
    runtimeTarget,
  };
  store.replace({ sessionStartedAt: 100, lastInteractionAt: 200 });
  await read();
  expect(readRetainedSessionEntryFacts(owner, request)).toMatchObject({
    lifecycleTimestamps: { sessionStartedAt: 100, lastInteractionAt: 200 },
    runtimeTarget: { ...runtimeTarget, storePath: scope.storePath },
  });
  expect(
    (await readSessionEntriesFromStoreInWorker({ ...input, lifecycleSessionKey: sessionKey }))
      .lifecycleTimestamps,
  ).toEqual({ sessionStartedAt: 100, lastInteractionAt: 200 });

  store.replace({
    sessionId: "replacement",
    updatedAt: 2,
    sessionStartedAt: 300,
    lastInteractionAt: 400,
  });
  expect(readRetainedSessionEntryFacts(owner, request)).toBeUndefined();
  expect((await entry())?.sessionId).toBe("replacement");
  const currentRequest = {
    ...request,
    runtimeTarget: { ...runtimeTarget, sessionId: "replacement" },
  };
  expect(readRetainedSessionEntryFacts(owner, currentRequest)).toMatchObject({
    lifecycleTimestamps: { sessionStartedAt: 300, lastInteractionAt: 400 },
    runtimeTarget: { ...currentRequest.runtimeTarget, storePath: scope.storePath },
  });
  expect(readRetainedSessionEntryFacts(owner, request)).toBeUndefined();

  store.replace({ sessionId: "replacement", updatedAt: 3 });
  await read();
  expect(readRetainedSessionEntryFacts(owner, currentRequest)).toBeUndefined();
});

test("refreshes cached sharing on revocation and entry replacement", async ({ store }) => {
  const { scope, sessionKey, read: readExact } = store;
  const skillsSnapshot = { prompt: "retained prompt".repeat(8192), skills: [] };
  store.replace({ skillsSnapshot });
  addSessionMember(scope, { identityId: "reader", addedBy: "owner", addedAt: 1 });
  const input = { ...store.input, includeAuthorization: true };
  const read = (projection: "sharing" | "full") =>
    readExact({
      includeAuthorization: true,
      projection,
      includeMembers: projection === "full",
      snapshotFields: projection === "sharing" ? ["skillsSnapshot"] : undefined,
    });
  await read("full");
  const warm = await read("sharing");
  expect(warm.entries[0]?.entry.sessionId).toBe("original");
  expect(warm.entries[0]?.entry).not.toHaveProperty("skillsSnapshot");
  expect(warm.sharing).toMatchObject({
    databaseIdentity: expect.stringMatching(/^file:/u),
    members: [{ sessionKey, identityIds: ["reader"] }],
    placeholders: [],
  });

  await removeSessionMemberInWorker(scope, "reader");
  const revoked = await read("sharing");
  expect(revoked.sharing?.members).toEqual([{ sessionKey, identityIds: [] }]);
  expect(revoked.entries[0]?.entry).not.toHaveProperty("skillsSnapshot");
  expect((await read("full")).entries[0]?.entry.skillsSnapshot).toEqual(skillsSnapshot);

  store.replace({
    sessionId: "replacement",
    lifecycleRevision: "replacement-revision",
    updatedAt: 2,
  });
  expect((await read("sharing")).entries[0]?.entry).toMatchObject({
    sessionId: "replacement",
    lifecycleRevision: "replacement-revision",
  });

  const missing = { ...input, sessionKeys: ["agent:main:absent-sharing"] };
  await readSessionEntriesFromStoreInWorker(missing);
  const absent = await readSessionEntriesFromStoreInWorker({
    ...missing,
    projection: "sharing",
  });
  expect(absent.entries).toEqual([]);
});

test("orders patch receipts before reads and preserves full snapshots", async ({ store }) => {
  const { scope, input, sessionKey, read: readExact, entry } = store;
  const skillsSnapshot = { prompt: "saved session instructions", skills: [] };
  store.replace({ sessionId: "same-session", label: "before", skillsSnapshot });
  expect((await entry())?.label).toBe("before");
  const entered = createDeferred();
  const ready = createDeferred();
  const prepared = createDeferred();
  const order: string[] = [];
  const patch = patchSessionEntryCore(
    scope,
    async () => {
      entered.resolve();
      await ready.promise;
      return { label: "after" };
    },
    {
      workerGuard: {},
      skipMaintenance: true,
      onCommitted: () => {
        order.push("write");
      },
    },
  );
  void patch.catch(() => {});
  let read: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, patch, "Patch preparation did not begin");
    read = withSessionEntriesFromStoresInWorker(
      [input],
      ([preparedEntry]) => {
        preparedEntry?.assertCurrent();
        expect(preparedEntry?.result.entries[0]?.entry.label).toBe("after");
        order.push("read");
      },
      { ordered: true, prepareSource: () => prepared.resolve() },
    );
    void read.catch(() => {});
    await awaitGateBeforeSettlement(prepared.promise, read, "Read source was not prepared");
    expect(order).toEqual([]);
    ready.resolve();
    await Promise.all([patch, read]);
    expect(order).toEqual(["write", "read"]);

    const metadata = await readExact({
      snapshotFields: [],
      includeMembers: true,
    });
    expect(metadata.members?.[sessionKey]).toEqual([]);
    expect(metadata.entries[0]?.entry.skillsSnapshot).toBeUndefined();
    expect(await entry()).toMatchObject({
      label: "after",
      skillsSnapshot,
    });
  } finally {
    ready.resolve();
    await Promise.allSettled([patch, ...(read ? [read] : [])]);
  }
});

test("refreshes cached entry, participant and membership writes", async ({ store }) => {
  const { scope, sessionKey, read: readExact } = store;
  store.replace({ sessionId: "same-session" });
  const read = () => readExact({ includeMembers: true, includeParticipantRecords: true });
  const missingKey = "agent:main:previously-absent";
  const readMissing = () =>
    readExact({ sessionKeys: [missingKey], includeMembers: true, includeParticipantRecords: true });
  const initial = await read();
  expect(initial.entries[0]?.entry.sessionId).toBe("same-session");
  expect((await read()).members?.[sessionKey]).toEqual([]);
  replaceSessionEntrySync(
    { ...scope, sessionKey: "agent:main:unrelated" },
    { sessionId: "unrelated", updatedAt: 2 },
  );
  expect(await read()).toEqual(initial);
  store.replace({ sessionId: "same-session", updatedAt: 3, label: "receipt-only" });
  expect((await store.entry())?.label).toBe("receipt-only");
  expect((await read()).entries[0]?.entry.label).toBe("receipt-only");
  expect((await readMissing()).entries).toEqual([]);
  replaceSessionEntrySync(
    { ...scope, sessionKey: missingKey },
    {
      sessionId: "created-after-miss",
      updatedAt: 1,
    },
  );
  expect((await readMissing()).entries[0]?.entry.sessionId).toBe("created-after-miss");
  for (const writer of ["native", "worker"] as const) {
    const participant = { identity: { type: "agent" as const, id: writer }, promptedAt: 20 };
    const member = { identityId: writer, addedBy: "owner", addedAt: 10 };
    if (writer === "native") {
      store.replace({ sessionId: "same-session", updatedAt: 2, label: writer });
      recordSessionParticipant(scope, participant);
      addSessionMember(scope, member);
    } else {
      await patchSessionEntryCore(scope, () => ({ label: writer }), {
        workerGuard: {},
        skipMaintenance: true,
      });
      await recordSessionParticipantInWorker(scope, participant);
      await addSessionMemberInWorker(scope, member);
    }
    const changed = await read();
    expect(changed.entries[0]?.entry).toMatchObject({ label: writer });
    expect(changed.entries[0]?.entry.participants).toContainEqual({
      identity: participant.identity,
    });
    expect(changed.participantRecords?.[sessionKey]).toContainEqual(
      expect.objectContaining({
        identity: participant.identity,
        contributionCount: 1,
      }),
    );
    expect(changed.members?.[sessionKey]).toEqual([member]);
    expect(await read()).toEqual(changed);
    await patchSessionEntryCore(scope, () => ({ label: `${writer}-metadata` }), {
      assertCommitAllowed() {},
      shouldCommit: () => true,
      skipMaintenance: true,
    });
    const patched = await read();
    expect(patched.entries[0]?.entry.label).toBe(`${writer}-metadata`);
    expect(patched.members).toEqual(changed.members);
    expect(patched.participantRecords).toEqual(changed.participantRecords);
    const repeated = { ...participant, promptedAt: 22 };
    if (writer === "native") {
      recordSessionParticipant(scope, repeated);
    } else {
      await recordSessionParticipantInWorker(scope, repeated);
    }
    await patchSessionEntryCore(scope, () => ({ label: writer }), {
      assertCommitAllowed() {},
      shouldCommit: () => true,
      skipMaintenance: true,
    });
    const contributed = await read();
    expect(contributed.participantRecords?.[sessionKey]).toContainEqual(
      expect.objectContaining({
        identity: participant.identity,
        contributionCount: 2,
        lastPromptedAt: 22,
      }),
    );
    if (writer === "native") {
      removeSessionMember(scope, writer);
    } else {
      await removeSessionMemberInWorker(scope, writer);
    }
    const removed = await read();
    expect(removed.members?.[sessionKey]).toEqual([]);
    expect(removed.participantRecords).toEqual(contributed.participantRecords);
  }
});

test("retains the foreground FIFO through a nested ordered read", async ({ store }) => {
  const { database, sessionKey, options, input } = store;
  writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
  const entered = createDeferred();
  const ready = createDeferred();
  const order: string[] = [];
  const outer = runOpenClawAgentWriteAdmission(options, async () => {
    entered.resolve();
    await ready.promise;
    await withSessionEntriesFromStoresInWorker(
      [input],
      ([read]) => {
        read?.assertCurrent();
        expect(read?.result.entries[0]?.entry.sessionId).toBe("original");
        order.push("read");
      },
      { ordered: true },
    );
    expect(order).toEqual(["read"]);
  });
  await awaitGateBeforeSettlement(entered.promise, outer, "Foreground admission did not begin");
  const following = runOpenClawAgentWriteAdmission(options, () => {
    order.push("writer");
  });
  ready.resolve();
  await Promise.all([outer, following]);
  expect(order).toEqual(["read", "writer"]);
});

test("reads through the active writer around its queued mutation", async ({ store }) => {
  const { scope, sessionKey, options, read: readExact } = store;
  const skillsSnapshot = { prompt: "retained instructions", skills: [] };
  store.replace({ sessionId: "writer-read", label: "before", skillsSnapshot });
  // A warm postimage must not overtake work already submitted to this writer.
  await readExact();
  await withSessionEntryWorker(
    options,
    undefined,
    () => {},
    async (execution, source) => {
      await execution.runExisting(source, async (worker) => {
        expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({
          label: "before",
          skillsSnapshot,
        });
        await worker.execute({
          type: "session.entry.patch.commit",
          input: {
            selection: { kind: "entry", sessionKey, exact: true },
            sessionKey,
            operationLabel: "session-entry.patch",
            validateCanonicalKeys: true,
            operation: { kind: "fields", patch: { label: "after" } },
          },
        });
        expect((await readExact()).entries[0]?.entry).toMatchObject({
          label: "after",
          skillsSnapshot,
        });
        expect(
          await readSessionEntryReadOnlyInWorker({ ...scope, projection: "list" }),
        ).toMatchObject({ label: "after" });
        expect(
          await readSessionEntryReadOnlyInWorker({ ...scope, sessionKey: "agent:main:absent" }),
        ).toBeUndefined();
      });
    },
  );
});

test("rejects an ordered read inside an active worker reservation", async ({ store }) => {
  const { database, sessionKey, options, input } = store;
  writeSessionEntry(database, sessionKey, { sessionId: "reserved", updatedAt: 1 });
  let consumed = false;
  const prepared = createDeferred();
  const { pending } = await runOpenClawAgentWorkerWrite(options, async () => {
    const read = withSessionEntriesFromStoresInWorker(
      [input],
      () => {
        consumed = true;
      },
      { ordered: true, prepareSource: () => prepared.resolve() },
    );
    void read.catch(() => {});
    await awaitGateBeforeSettlement(prepared.promise, read, "Reader source was not prepared");
    return { pending: read };
  });
  await expect(pending).rejects.toThrow("cannot reenter an active SQLite writer admission");
  expect(consumed).toBe(false);
});

test("rejects inherited store-order inversion", async ({ state: { env } }) => {
  const first = openOpenClawAgentDatabase({ agentId: "first", env });
  const second = openOpenClawAgentDatabase({ agentId: "second", env });
  const lower = first.path < second.path ? first : second;
  const higher = lower === first ? second : first;
  const sessionKey = `agent:${lower.agentId}:ordered-read`;
  writeSessionEntry(lower, sessionKey, { sessionId: "lower", updatedAt: 1 });
  await expect(
    runOpenClawAgentWriteAdmission({ agentId: higher.agentId, path: higher.path, env }, () =>
      withSessionEntriesFromStoresInWorker(
        [{ agentId: lower.agentId, storePath: lower.path, sessionKeys: [sessionKey], env }],
        () => {},
        { ordered: true },
      ),
    ),
  ).rejects.toThrow("would invert inherited SQLite writer admission order");
});

test("captures the physical source after its queued creation", async ({ state: { env } }) => {
  const database = { agentId: "cold-source", env };
  const storePath = resolveOpenClawAgentSqlitePath(database);
  const sessionKey = "agent:cold-source:admitted-source";
  const writerEntered = createDeferred();
  const create = createDeferred();
  const readEntered = createDeferred();
  let capturedIdentity: { key: string; birthtime?: string } | undefined;
  const writer = runOpenClawAgentWriteAdmission(database, async () => {
    writerEntered.resolve();
    await create.promise;
    const opened = openOpenClawAgentDatabase(database);
    writeSessionEntry(opened, sessionKey, { sessionId: "admitted-source", updatedAt: 1 });
  });
  await writerEntered.promise;
  const read = withSessionStoreReaderInWorker(
    { ...database, storePath },
    async ({ reader }) => {
      readEntered.resolve();
      return reader.readExactEntries({ sessionKeys: [sessionKey], env });
    },
    {
      prepareSource: (_source, identity) => {
        capturedIdentity = identity;
      },
    },
  );
  try {
    await awaitGateBeforeSettlement(readEntered.promise, read, "Cold read bypassed admission");
    create.resolve();
    const [result] = await Promise.all([read, writer]);
    expect(result.entries[0]?.entry.sessionId).toBe("admitted-source");
    expect(capturedIdentity).toMatchObject({
      key: `file:${result.source?.databaseIdentity}`,
      birthtime: result.source?.databaseBirthtime,
    });
  } finally {
    create.resolve();
    await Promise.allSettled([read, writer]);
  }
});
