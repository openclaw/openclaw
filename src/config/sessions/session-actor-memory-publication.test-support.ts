import { expect, vi } from "vitest";
import type { SessionActorStorage } from "./session-actor-contract.js";
import * as publication from "./session-actor-memory-publication.js";
import { createSessionActorMemoryState } from "./session-actor-memory-state.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorageOutcome,
  SessionActorStorageReads,
  SessionActorStorageWrites,
} from "./session-actor-storage-contract.js";
import type { InternalSessionEntry } from "./types.js";

const memoryAuthority = { assertCurrent() {}, authorize() {} };

export function createMemoryTestState(sessionKey: string, entry: InternalSessionEntry) {
  const state = createSessionActorMemoryState({
    database: { kind: "memory", handle: "memory-1", incarnation: "incarnation-1" },
    sessionKey,
  });
  Object.assign(state.hot, {
    version: { epoch: "epoch-1", sequence: 0 },
    writeToken: "0",
    dependencySessionIds: [entry.sessionId],
    entry,
  });
  return state;
}

export function committedMemoryResult<T>(outcome: SessionActorStorageOutcome<T>): T {
  expect(outcome.kind).toBe("committed");
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  expect(outcome.failure).toBeUndefined();
  return outcome.value;
}

export function memoryStorage(
  raw: SessionActorStorage,
  authority: SessionActorStorageAuthority = memoryAuthority,
) {
  return {
    read<Key extends keyof SessionActorStorageReads>(
      type: Key,
      input: SessionActorStorageReads[Key]["input"],
    ) {
      return readMemory(raw, type, input, authority);
    },
    commit<Key extends keyof SessionActorStorageWrites>(
      type: Key,
      input: SessionActorStorageWrites[Key]["input"],
    ) {
      return commitMemory(raw, type, input, authority);
    },
  };
}

export function readMemory<Key extends keyof SessionActorStorageReads>(
  storage: SessionActorStorage,
  type: Key,
  input: SessionActorStorageReads[Key]["input"],
  authority: SessionActorStorageAuthority = memoryAuthority,
) {
  return storage.read({ type, input }, authority);
}

export function mutateMemory<Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  type: Key,
  input: SessionActorStorageWrites[Key]["input"],
  authority: SessionActorStorageAuthority = memoryAuthority,
) {
  return storage.mutate({ type, input }, authority);
}

export async function commitMemory<Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  type: Key,
  input: SessionActorStorageWrites[Key]["input"],
  authority: SessionActorStorageAuthority = memoryAuthority,
) {
  return committedMemoryResult(await storage.mutate({ type, input }, authority));
}

export function failSessionActorMemoryPublication(sessionKey: string): () => void {
  const publish = publication.publishSessionActorMemoryChanges;
  const spy = vi
    .spyOn(publication, "publishSessionActorMemoryChanges")
    .mockImplementation((owner, changes) => {
      publish(owner, changes);
      if (changes.some((change) => change.sessionKey === sessionKey)) {
        throw new Error("Memory publication failed after commit");
      }
    });
  return () => spy.mockRestore();
}
