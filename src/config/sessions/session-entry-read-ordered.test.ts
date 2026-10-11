import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { readSessionNodesGeneration } from "./session-accessor.sqlite-entry-revision.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  readSessionEntriesFromStoreInWorker,
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import {
  addSessionMemberInWorker,
  recordSessionParticipantInWorker,
  removeSessionMemberInWorker,
} from "./session-sharing-store.async.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import { projectionLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";

function observeEntryReaderRequests() {
  const requests = [projectionLane, targetDiscoveryLane].map(({ pool }) => vi.spyOn(pool, "run"));
  return {
    count: () => requests.reduce((count, request) => count + request.mock.calls.length, 0),
    clear: () => requests.forEach((request) => request.mockClear()),
    restore: () => requests.forEach((request) => request.mockRestore()),
  };
}

it("retains exact reads without dispatch, isolates agent stores, and evicts the least recently read of 128 entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const first = openOpenClawAgentDatabase({ agentId: "first", env });
    const second = openOpenClawAgentDatabase({ agentId: "second", env });
    const keys = Array.from({ length: 129 }, (_, index) => `agent:first:entry-${index}`);
    const internal = resolveInternalSessionEffectsIdentity({ agentId: "first", runId: "hidden" });
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const [index, key] of keys.entries()) {
          writeSessionEntry(database, key, { sessionId: `entry-${index}`, updatedAt: 1 });
        }
        writeSessionEntry(database, internal.sessionKey, {
          sessionId: internal.sessionId,
          updatedAt: 1,
        });
      },
      { agentId: first.agentId, path: first.path, env },
    );
    const otherKey = "agent:second:entry-0";
    writeSessionEntry(second, otherKey, { sessionId: "other-store", updatedAt: 1 });
    const read = (sessionKeys: string[]) =>
      readSessionEntriesFromStoreInWorker({
        agentId: first.agentId,
        storePath: first.path,
        env,
        sessionKeys,
      });
    const readOther = () =>
      readSessionEntriesFromStoreInWorker({
        agentId: second.agentId,
        storePath: second.path,
        env,
        sessionKeys: [otherKey],
      });
    const requests = observeEntryReaderRequests();
    try {
      expect((await read(keys.slice(0, 64))).entries).toHaveLength(64);
      expect((await read(keys.slice(64, 128))).entries).toHaveLength(64);
      expect((await readOther()).entries[0]?.entry.sessionId).toBe("other-store");
      expect(requests.count()).toBeGreaterThan(0);
      requests.clear();
      const repeated = await read([keys[0]!]);
      expect(repeated.entries[0]?.entry.sessionId).toBe("entry-0");
      repeated.entries[0]!.entry.sessionId = "caller-mutated";
      expect((await read([keys[0]!])).entries[0]?.entry.sessionId).toBe("entry-0");
      expect((await readOther()).entries[0]?.entry.sessionId).toBe("other-store");
      expect(requests.count()).toBe(0);

      expect((await read([keys[128]!])).entries[0]?.entry.sessionId).toBe("entry-128");
      expect(requests.count()).toBe(1);
      requests.clear();
      expect((await read([keys[0]!])).entries[0]?.entry.sessionId).toBe("entry-0");
      expect((await readOther()).entries[0]?.entry.sessionId).toBe("other-store");
      expect(requests.count()).toBe(0);
      expect((await read([keys[1]!])).entries[0]?.entry.sessionId).toBe("entry-1");
      expect(requests.count()).toBe(1);
      requests.clear();
      expect((await read([keys[1]!])).entries[0]?.entry.sessionId).toBe("entry-1");
      expect(requests.count()).toBe(0);
      expect((await read([internal.sessionKey])).entries[0]?.entry.sessionId).toBe(
        internal.sessionId,
      );
      expect(
        (
          await readSessionEntriesFromStoreInWorker({
            agentId: first.agentId,
            storePath: first.path,
            env,
            sessionKeys: [internal.sessionKey],
            projection: "list",
          })
        ).entries,
      ).toEqual([]);
    } finally {
      requests.restore();
    }
  });
});

it("consumes a queued patch receipt without dispatch and preserves its full snapshots across a partial refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:pending-patch";
    const scope = { agentId: "main", storePath: database.path, sessionKey, env };
    const skillsSnapshot = { prompt: "saved session instructions", skills: [] };
    replaceSessionEntrySync(scope, {
      sessionId: "same-session",
      updatedAt: 1,
      label: "before",
      skillsSnapshot,
    });
    const input = { agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env };
    expect((await readSessionEntriesFromStoreInWorker(input)).entries[0]?.entry.label).toBe(
      "before",
    );
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
    let requests: ReturnType<typeof observeEntryReaderRequests> | undefined;
    try {
      await awaitGateBeforeSettlement(entered.promise, patch, "Patch preparation did not begin");
      requests = observeEntryReaderRequests();
      read = withSessionEntriesFromStoresInWorker(
        [input],
        ([entry]) => {
          entry?.assertCurrent();
          expect(entry?.result.entries[0]?.entry.label).toBe("after");
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
      expect(requests.count()).toBe(0);

      const metadata = await readSessionEntriesFromStoreInWorker({
        ...input,
        snapshotFields: [],
        includeMembers: true,
      });
      expect(metadata.members?.[sessionKey]).toEqual([]);
      expect(metadata.entries[0]?.entry.skillsSnapshot).toBeUndefined();
      expect(requests.count()).toBe(1);
      requests.clear();
      expect((await readSessionEntriesFromStoreInWorker(input)).entries[0]?.entry).toMatchObject({
        label: "after",
        skillsSnapshot,
      });
      expect(requests.count()).toBe(0);
    } finally {
      ready.resolve();
      await Promise.allSettled([patch, ...(read ? [read] : [])]);
      requests?.restore();
    }
  });
});

it("observes native and worker entry, participant, and membership writes after cache priming", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:receipt-facts";
    const scope = { agentId: "main", storePath: database.path, sessionKey, env };
    replaceSessionEntrySync(scope, { sessionId: "same-session", updatedAt: 1 });
    const read = () =>
      readSessionEntriesFromStoreInWorker({
        ...scope,
        sessionKeys: [sessionKey],
        includeMembers: true,
        includeParticipantRecords: true,
      });
    const missingKey = "agent:main:previously-absent";
    const readMissing = () =>
      readSessionEntriesFromStoreInWorker({
        ...scope,
        sessionKeys: [missingKey],
        includeMembers: true,
        includeParticipantRecords: true,
      });
    const requests = observeEntryReaderRequests();
    try {
      expect((await read()).entries[0]?.entry.sessionId).toBe("same-session");
      requests.clear();
      expect((await read()).members?.[sessionKey]).toEqual([]);
      expect(requests.count()).toBe(0);
      expect((await readMissing()).entries).toEqual([]);
      requests.clear();
      expect((await readMissing()).entries).toEqual([]);
      expect(requests.count()).toBe(0);
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
          replaceSessionEntrySync(scope, {
            sessionId: "same-session",
            updatedAt: 2,
            label: writer,
          });
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
        requests.clear();
        expect(await read()).toEqual(changed);
        expect(requests.count()).toBe(0);
        if (writer === "native") {
          removeSessionMember(scope, writer);
        } else {
          await removeSessionMemberInWorker(scope, writer);
        }
        expect((await read()).members?.[sessionKey]).toEqual([]);
      }
    } finally {
      requests.restore();
    }
  });
});

it("keeps an ordered read current when session generation tracking initializes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const seeded = openOpenClawAgentDatabase(options);
    const sessionKey = "agent:main:cold-generation";
    writeSessionEntry(seeded, sessionKey, { sessionId: "original", updatedAt: 1 });
    await closeOpenClawAgentDatabaseByPathAsync(seeded.path, seeded.agentId);
    const database = openOpenClawAgentDatabase(options);
    await expect(
      withSessionEntriesFromStoresInWorker(
        [{ ...options, storePath: database.path, sessionKeys: [sessionKey] }],
        ([read]) => {
          read!.assertCurrent();
          return read!.result.entries[0]?.entry.sessionId;
        },
        {
          ordered: true,
          onReadAdmitted: () => {
            expect(database.db.prepare("SELECT name FROM temp.sqlite_schema").all()).toEqual([]);
            expect(readSessionNodesGeneration(database.db)).toBe(0);
          },
        },
      ),
    ).resolves.toBe("original");
  });
});

it("retains the foreground FIFO through a nested ordered read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:nested-read";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const options = { agentId: "main", path: database.path, env };
    const entered = createDeferred();
    const ready = createDeferred();
    const order: string[] = [];
    const outer = runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await ready.promise;
      await withSessionEntriesFromStoresInWorker(
        [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
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
});

it("reads entries through the active writer before and after its queued mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:writer-read";
    const scope = { agentId: "main", storePath: database.path, sessionKey, env };
    const skillsSnapshot = { prompt: "retained instructions", skills: [] };
    replaceSessionEntrySync(scope, {
      sessionId: "writer-read",
      updatedAt: 1,
      label: "before",
      skillsSnapshot,
    });
    const readExact = () =>
      readSessionEntriesFromStoreInWorker({ ...scope, sessionKeys: [sessionKey] });
    // A warm postimage must not overtake work already submitted to this writer.
    await readExact();
    await withSessionEntryWorker(
      { agentId: "main", path: database.path, env },
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
});

it("rejects an ordered read inside an active worker reservation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:reserved-read";
    writeSessionEntry(database, sessionKey, { sessionId: "reserved", updatedAt: 1 });
    let consumed = false;
    const prepared = createDeferred();
    const { pending } = await runOpenClawAgentWorkerWrite(
      { agentId: "main", path: database.path, env },
      async () => {
        const read = withSessionEntriesFromStoresInWorker(
          [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
          () => {
            consumed = true;
          },
          { ordered: true, prepareSource: () => prepared.resolve() },
        );
        void read.catch(() => {});
        await awaitGateBeforeSettlement(prepared.promise, read, "Reader source was not prepared");
        return { pending: read };
      },
    );
    await expect(pending).rejects.toThrow("cannot reenter an active SQLite writer admission");
    expect(consumed).toBe(false);
  });
});

it("rejects ordered reads that invert an inherited store acquisition", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
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
});
