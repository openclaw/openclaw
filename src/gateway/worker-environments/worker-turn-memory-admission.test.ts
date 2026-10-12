import { afterEach, expect, it, vi } from "vitest";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import {
  captureWorkerTurnTranscriptSource,
  resolveWorkerTurnTranscriptTarget,
  withWorkerTurnTranscriptDatabase,
} from "./worker-turn-transcript-target.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory worker admission opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory worker admission allocated a database worker");
  }),
}));

const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-memory-worker",
    sessionId: "memory-worker",
    storePath: "/synthetic/incognito-worker",
    expectedLifecycleRevision: "original",
    expectedWriterRunId: "writer-1",
  };
  const owner = createMemorySessionActorOwner({ agentId: target.agentId, path: target.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: target.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const authority = { assertCurrent() {}, authorize() {} };
  const initialized = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: {
          sessionId: target.sessionId,
          lifecycleRevision: target.expectedLifecycleRevision,
          activeWriterRunId: target.expectedWriterRunId,
          updatedAt: 1,
          incognito: true,
        },
      },
    },
    authority,
  );
  expect(initialized.kind).toBe("committed");
  return {
    owner,
    actor,
    authority,
    target,
    binding: { actor, authority, agentId: target.agentId, path: target.storePath },
  };
}

it("uses committed writer changes for the next worker transcript effect without SQLite", async () => {
  const { actor, authority, target, binding } = await fixture();
  await runWithSessionActorStorage(binding, async () => {
    const source = captureWorkerTurnTranscriptSource(target);
    expect(resolveWorkerTurnTranscriptTarget({ ...target, sessionTarget: target })).toEqual(target);
    source();
    const changed = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { activeWriterRunId: "writer-2" } } },
      },
      authority,
    );
    expect(changed.kind).toBe("committed");
    expect(source).toThrow("transcript identity is no longer current");
    const next = { ...target, expectedWriterRunId: "writer-2" };
    expect(resolveWorkerTurnTranscriptTarget({ ...next, sessionTarget: next })).toEqual(next);
  });
});

it.each([false, true])(
  "settles placement authority and refuses an actor closed during preparation (%s)",
  async (close) => {
    const { owner, target, binding } = await fixture();
    const release = vi.fn();
    const run = vi.fn(async () => "settled");
    const result = runWithSessionActorStorage(binding, () =>
      withWorkerTurnTranscriptDatabase(
        { ...target, sessionTarget: target },
        {
          assertCurrent() {},
          async prepareAuthority() {
            if (close) {
              owner.closeSession(target.sessionKey);
            }
            return { isCurrent: () => true, release };
          },
        },
        run,
      ),
    );
    if (close) {
      await expect(result).rejects.toThrow("closed");
      expect(run).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe("settled");
      expect(run).toHaveBeenCalledOnce();
    }
    expect(release).toHaveBeenCalledOnce();
  },
);
