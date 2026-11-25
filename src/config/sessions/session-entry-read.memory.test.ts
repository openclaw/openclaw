import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createSessionEntryWithTranscript,
  prepareSessionEntryMutationDatabases,
} from "./session-accessor.entry-mutation.js";
import {
  readResolvedSessionEntryInWorker,
  resolveSessionEntryCandidateTargetForRuntime,
} from "./session-accessor.entry.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import { captureNativeSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import { prepareSessionEntryPresenceRead } from "./session-entry-presence-read.js";
import {
  createSessionEntryListReader,
  readSessionEntriesFromStoreInWorker,
  readSessionEntryByIdReadOnlyInWorker,
  readSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionEntryInWorker } from "./session-entry-read-writable.js";
import type { SessionEntry } from "./types.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

function fixture() {
  const env = { OPENCLAW_STATE_DIR: `/tmp/openclaw-memory-entry-${randomUUID()}` };
  const agentId = "main";
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const sessionKey = "agent:main:dashboard:incognito-read";
  return {
    scope: { agentId, storePath, sessionKey, env },
    database: { agentId, path: storePath },
  };
}

const create = (entry: Partial<SessionEntry> = {}) =>
  ({
    type: "session.entry.create",
    input: { entry: { sessionId: "memory-read", updatedAt: 1, incognito: true, ...entry } },
  }) as const;
const patchFields = (patch: Partial<SessionEntry>) =>
  ({ type: "session.entry.patch", input: { operation: { kind: "fields", patch } } }) as const;

it("unbound child readers observe memory lineage writes without opening SQLite", async () => {
  const { scope, database } = fixture();
  const owner = memorySessionActorOwners.get(database);
  const childKey = "agent:main:dashboard:incognito-child";
  const actor = await owner.acquire({ database: owner.identity, sessionKey: childKey }, lifetime);
  try {
    await actor.storage!.mutate(
      create({
        sessionId: "child",
        skillsSnapshot: { prompt: "private instructions", skills: [] },
      }),
      authority,
    );
    expect(await listSessionChildEntriesReadOnly(scope)).toEqual([]);
    await actor.storage!.mutate(patchFields({ parentSessionKey: scope.sessionKey }), authority);
    const children = await listSessionChildEntriesReadOnly({ ...scope, projection: "list" });
    expect(children).toMatchObject([{ sessionKey: childKey, entry: { sessionId: "child" } }]);
    expect(children[0]?.entry).not.toHaveProperty("skillsSnapshot");
    const selected = await readSessionEntriesFromStoreInWorker({
      ...scope,
      selection: { kind: "children", parentSessionKeys: [scope.sessionKey] },
      projection: "list",
    });
    expect(selected.entries).toMatchObject([
      { sessionKey: childKey, entry: { parentSessionKey: scope.sessionKey } },
    ]);
    expect(await listSessionChildEntriesReadOnly(scope, [scope.sessionKey, childKey])).toEqual([]);
  } finally {
    await actor.release();
    memorySessionActorOwners.closeDatabase(database);
  }
});

it("keeps absent incognito metadata absent across ordinary read entry points", async () => {
  const { scope, database } = fixture();
  expect(await readSessionEntryReadOnlyInWorker(scope)).toBeUndefined();
  expect(await readSessionEntryInWorker(scope)).toBeUndefined();
  expect(await prepareSessionEntryPresenceRead(scope).read()).toBe(false);
  expect(
    await readSessionEntryByIdReadOnlyInWorker({ ...scope, sessionId: "missing" }),
  ).toBeUndefined();
  expect((await createSessionEntryListReader(scope)()).entries).toEqual([]);
  expect(
    (await readSessionEntriesFromStoreInWorker({ ...scope, sessionKeys: [scope.sessionKey] }))
      .entries,
  ).toEqual([]);
  expect(memorySessionActorOwners.read(database)).toBeUndefined();
});

it("unbound readers observe committed entry and sharing changes without replacing their owner", async () => {
  const { scope, database } = fixture();
  const binding = await acquireSessionActorStorage(scope, { authority, lifetime, create: true });
  expect(binding).toBeDefined();
  try {
    runWithSessionActorStorage(binding!, () => {
      expect(
        captureSessionActorStorageOwner({
          agentId: scope.agentId,
          storePath: `${scope.env.OPENCLAW_STATE_DIR}/durable.sqlite`,
        }),
      ).toBeUndefined();
    });
    const storage = binding!.actor.storage;
    const commit = async (command: Parameters<typeof storage.mutate>[0]) => {
      expect((await storage.mutate(command, authority)).kind).toBe("committed");
    };
    await commit(create({ modelSelectionLocked: false }));
    const current = captureNativeSessionEntryCurrentRead(scope);
    const list = createSessionEntryListReader(scope);
    expect(current.readCurrent()?.modelSelectionLocked).toBe(false);
    expect((await list()).entries[0]?.entry.updatedAt).toBe(1);
    using now = vi.spyOn(Date, "now");
    now.mockReturnValue(2);
    await commit(patchFields({ updatedAt: 2, modelSelectionLocked: true }));
    await commit({
      type: "session.collaboration.add",
      input: { params: { identityId: "fixture-reader", addedBy: "fixture-owner", addedAt: 3 } },
    });
    expect(current.readCurrent()?.modelSelectionLocked).toBe(true);
    expect((await list()).entries[0]?.entry.updatedAt).toBe(2);
    const readById = (sessionId: string) =>
      readSessionEntryByIdReadOnlyInWorker({ ...scope, sessionId });
    expect([
      (await readSessionEntryInWorker(scope))?.updatedAt,
      (await readById("memory-read"))?.entry.updatedAt,
      (await readById(" memory-read "))?.entry.updatedAt,
    ]).toEqual([2, 2, 2]);
    const batch = await readSessionEntriesFromStoreInWorker({
      ...scope,
      sessionKeys: [scope.sessionKey],
      projection: "sharing",
      includeMembers: true,
    });
    expect(batch.entries[0]?.entry.updatedAt).toBe(2);
    expect(batch.sharing?.members).toEqual([
      { sessionKey: scope.sessionKey, identityIds: ["fixture-reader"] },
    ]);
    expect(batch.members?.[scope.sessionKey]).toEqual([
      { identityId: "fixture-reader", addedBy: "fixture-owner", addedAt: 3 },
    ]);
  } finally {
    await binding?.actor.release();
    memorySessionActorOwners.closeDatabase(database);
  }
});

it("admits an absent memory session and keeps creation and subsequent reads on that owner", async () => {
  const { scope, database } = fixture();
  const admitted = await loadSessionEntryForAdmission(scope);
  expect(admitted.entry).toBeUndefined();
  const absentId = await captureSessionEntryCurrentCheckAsyncInternal({
    ...scope,
    sessionId: "created-memory",
  });
  const claim = admitted.databaseClaim;
  if (!("kind" in claim)) {
    throw new Error("Expected an actor admission claim");
  }
  let actor: Awaited<ReturnType<typeof claim.acquireSessionActor>> | undefined;
  let next: typeof claim | undefined;
  try {
    expect(() => absentId.source()).not.toThrow();
    await using preparation = prepareSessionEntryMutationDatabases(
      [{ scope, assertCurrent: () => claim.assertCurrent() }],
      Promise.resolve(),
    );
    expect((await preparation.preparations[0])?.execution).toBeUndefined();
    const created = await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: "created-memory", updatedAt: 1, incognito: true },
    }));
    expect(created.ok).toBe(true);
    expect(() => absentId.source()).toThrow("selected session changed");
    actor = await claim.acquireSessionActor({ assertCurrent() {}, assertReadable() {} });
    expect(actor.target.database).toMatchObject({
      kind: "memory",
      incarnation: claim.incarnation,
    });
    const patched = await actor.patch(
      {
        commandId: "admitted-entry-update",
        phaseId: "test",
        reducers: [{ kind: "activity", updatedAt: 2 }],
      },
      authority,
    );
    expect(patched.kind).toBe("committed");
    expect((await readResolvedSessionEntryInWorker({ ...scope, cfg: {} }))?.updatedAt).toBe(2);
    const candidate = await resolveSessionEntryCandidateTargetForRuntime({
      agentId: scope.agentId,
      env: scope.env,
      cfg: {},
      candidateKeys: ["agent:main:absent", scope.sessionKey],
    });
    expect(candidate?.entry.updatedAt).toBe(2);
    next = await claim.afterTransition?.({ current: { sessionId: "created-memory" } }, () => {});
    expect(next?.incarnation).toBe(claim.incarnation);
    await claim.release();
    next?.assertCurrent();
    memorySessionActorOwners.closeDatabase(database);
    expect(() => next?.assertCurrent()).toThrow(/closed/);
  } finally {
    absentId.release();
    await actor?.release();
    await next?.release();
    await claim.release();
    memorySessionActorOwners.closeDatabase(database);
  }
});
