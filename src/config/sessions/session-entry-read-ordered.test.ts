import { serialize } from "node:v8";
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

test("refreshes cached sharing, lifecycle and runtime targets on replacement", async ({
  store,
}) => {
  const { scope, sessionKey, options: owner, read: readExact } = store;
  const skillsSnapshot = { prompt: "retained prompt".repeat(8192), skills: [] };
  store.replace({ skillsSnapshot, sessionStartedAt: 100, lastInteractionAt: 200 });
  addSessionMember(scope, { identityId: "reader", addedBy: "owner", addedAt: 1 });
  const runtimeTarget = { agentId: "logical", sessionId: "original", sessionKey };
  const request = { sessionKeys: [sessionKey], lifecycleSessionKey: sessionKey, runtimeTarget };
  const facts = (sessionId = "original") =>
    readRetainedSessionEntryFacts(owner, {
      ...request,
      runtimeTarget: { ...runtimeTarget, sessionId },
    });
  const read = (projection: "sharing" | "full") =>
    readExact({
      includeAuthorization: true,
      projection,
      includeMembers: projection === "full",
      snapshotFields: projection === "sharing" ? ["skillsSnapshot"] : undefined,
    });
  await read("full");
  expect(facts()).toMatchObject({
    lifecycleTimestamps: { sessionStartedAt: 100, lastInteractionAt: 200 },
    runtimeTarget: { ...runtimeTarget, storePath: scope.storePath },
  });
  expect((await readExact({ lifecycleSessionKey: sessionKey })).lifecycleTimestamps).toEqual({
    sessionStartedAt: 100,
    lastInteractionAt: 200,
  });
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
    sessionStartedAt: 300,
    lastInteractionAt: 400,
  });
  expect(facts()).toBeUndefined();
  expect((await read("sharing")).entries[0]?.entry).toMatchObject({
    sessionId: "replacement",
    lifecycleRevision: "replacement-revision",
  });
  await read("full");
  expect(facts("replacement")).toMatchObject({
    lifecycleTimestamps: { sessionStartedAt: 300, lastInteractionAt: 400 },
    runtimeTarget: { ...runtimeTarget, sessionId: "replacement", storePath: scope.storePath },
  });
  expect(facts()).toBeUndefined();
  store.replace({ sessionId: "replacement", updatedAt: 3 });
  await read("full");
  expect(facts("replacement")).toBeUndefined();

  const missing = {
    ...store.input,
    includeAuthorization: true,
    sessionKeys: ["agent:main:absent-sharing"],
  };
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
  const patch = (label: string) =>
    patchSessionEntryCore(scope, () => ({ label }), {
      assertCommitAllowed() {},
      shouldCommit: () => true,
      skipMaintenance: true,
    });
  for (const [writer, record, add, remove] of [
    ["native", recordSessionParticipant, addSessionMember, removeSessionMember],
    [
      "worker",
      recordSessionParticipantInWorker,
      addSessionMemberInWorker,
      removeSessionMemberInWorker,
    ],
  ] as const) {
    const participant = { identity: { type: "agent" as const, id: writer }, promptedAt: 20 };
    const member = { identityId: writer, addedBy: "owner", addedAt: 10 };
    if (writer === "native") {
      store.replace({ sessionId: "same-session", updatedAt: 2, label: writer });
    } else {
      await patchSessionEntryCore(scope, () => ({ label: writer }), {
        workerGuard: {},
        skipMaintenance: true,
      });
    }
    await record(scope, participant);
    await add(scope, member);
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
    await patch(`${writer}-metadata`);
    const patched = await read();
    expect(patched.entries[0]?.entry.label).toBe(`${writer}-metadata`);
    expect(patched.members).toEqual(changed.members);
    expect(patched.participantRecords).toEqual(changed.participantRecords);
    await record(scope, { ...participant, promptedAt: 22 });
    await patch(writer);
    const contributed = await read();
    expect(contributed.participantRecords?.[sessionKey]).toContainEqual(
      expect.objectContaining({
        identity: participant.identity,
        contributionCount: 2,
        lastPromptedAt: 22,
      }),
    );
    await remove(scope, writer);
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

test("writer entry replies omit unused sharing facts while plain readers retain them", async ({
  store,
}) => {
  const { scope, options, sessionKey } = store;
  store.replace({ skillsSnapshot: { prompt: "saved instructions", skills: [] } });
  recordSessionParticipant(scope, {
    identity: { type: "agent", id: "contributor" },
    promptedAt: 20,
  });
  const read = () =>
    withSessionEntryWorker(
      options,
      undefined,
      () => {},
      (execution, source) =>
        execution.runExisting(source, (worker) =>
          worker.execute({
            type: "session.entry.readResult",
            input: {
              kind: "session-entry-read",
              database: options,
              scope: { ...scope, databaseAgentId: options.agentId },
            },
          }),
        ),
    );
  const before = await read();
  for (let index = 0; index < 16; index++) {
    addSessionMember(scope, { identityId: `member-${index}`, addedBy: "owner", addedAt: 10 });
  }
  const after = await read();
  expect(after?.entry).toMatchObject({
    sessionId: "original",
    skillsSnapshot: { prompt: "saved instructions", skills: [] },
    participants: [{ identity: { type: "agent", id: "contributor" } }],
  });
  expect(after?.source).toEqual(before?.source);
  expect(serialize(after).byteLength).toBe(serialize(before).byteLength);
  await withSessionStoreReaderInWorker(scope, async ({ reader }) => {
    const plain = await reader.readEntryResult({
      scope: { ...scope, databaseAgentId: options.agentId },
    });
    expect(plain.ok && plain.value).toEqual(after?.entry);
    expect(plain.facts?.members?.[sessionKey]).toHaveLength(16);
    expect(plain.facts?.participantRecords?.[sessionKey]).toMatchObject([
      { identity: { type: "agent", id: "contributor" }, contributionCount: 1 },
    ]);
  });
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
