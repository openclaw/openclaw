import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
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
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { captureNativeSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import { prepareSessionEntryPresenceRead } from "./session-entry-presence-read.js";
import {
  createSessionEntryListReader,
  readSessionEntriesFromStoreInWorker,
  readSessionEntryByIdReadOnlyInWorker,
  readSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionEntryInWorker } from "./session-entry-read-writable.js";

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
  const authority = { assertCurrent() {}, authorize() {} };
  const lifetime = { assertCurrent() {}, assertReadable() {} };
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
    const created = await binding!.actor.storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: "memory-read", updatedAt: 1, incognito: true } },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
    const current = captureNativeSessionEntryCurrentRead(scope);
    const list = createSessionEntryListReader(scope);
    expect(current.readCurrent()?.updatedAt).toBe(1);
    expect((await list()).entries[0]?.entry.updatedAt).toBe(1);
    const patched = await binding!.actor.patch(
      {
        commandId: "read-after-write",
        phaseId: "read-test",
        reducers: [{ kind: "activity", updatedAt: 2 }],
      },
      authority,
    );
    expect(patched.kind).toBe("committed");
    const shared = await binding!.actor.storage.mutate(
      {
        type: "session.collaboration.add",
        input: { params: { identityId: "fixture-reader", addedBy: "fixture-owner", addedAt: 3 } },
      },
      authority,
    );
    expect(shared.kind).toBe("committed");
    expect(current.readCurrent()?.updatedAt).toBe(2);
    expect((await list()).entries[0]?.entry.updatedAt).toBe(2);
    expect((await readSessionEntryInWorker(scope))?.updatedAt).toBe(2);
    expect(
      (await readSessionEntryByIdReadOnlyInWorker({ ...scope, sessionId: "memory-read" }))?.entry
        .updatedAt,
    ).toBe(2);
    expect(
      (await readSessionEntryByIdReadOnlyInWorker({ ...scope, sessionId: " memory-read " }))?.entry
        .updatedAt,
    ).toBe(2);
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
  const claim = admitted.databaseClaim;
  if (!("kind" in claim)) {
    throw new Error("Expected an actor admission claim");
  }
  let actor: Awaited<ReturnType<typeof claim.acquireSessionActor>> | undefined;
  let next: typeof claim | undefined;
  try {
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
    actor = await claim.acquireSessionActor({ assertCurrent() {}, assertReadable() {} });
    expect(actor.target.database).toMatchObject({
      kind: "memory",
      incarnation: claim.incarnation,
    });
    const authority = { assertCurrent() {}, authorize() {} };
    expect(
      (
        await actor.patch(
          {
            commandId: "admitted-entry-update",
            phaseId: "test",
            reducers: [{ kind: "activity", updatedAt: 2 }],
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    expect((await readResolvedSessionEntryInWorker({ ...scope, cfg: {} }))?.updatedAt).toBe(2);
    expect(
      resolveSessionEntryCandidateTargetForRuntime({
        agentId: scope.agentId,
        env: scope.env,
        cfg: {},
        candidateKeys: ["agent:main:absent", scope.sessionKey],
      })?.entry.updatedAt,
    ).toBe(2);
    next = await claim.afterTransition?.({ current: { sessionId: "created-memory" } }, () => {});
    expect(next?.incarnation).toBe(claim.incarnation);
    await claim.release();
    next?.assertCurrent();
    memorySessionActorOwners.closeDatabase(database);
    expect(() => next?.assertCurrent()).toThrow(/closed/);
  } finally {
    await actor?.release();
    await next?.release();
    await claim.release();
    memorySessionActorOwners.closeDatabase(database);
  }
});
