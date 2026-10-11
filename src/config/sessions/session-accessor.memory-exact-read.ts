import path from "node:path";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";

/** An exact reader borrows the selected owner; absence never opens or acquires a backend. */
export function captureMemoryExactSessionReader(
  scope: {
    agentId?: string;
    storePath?: string;
    sessionKey?: string;
    env?: NodeJS.ProcessEnv;
    sessionActor?: SessionActorStorageBinding;
  },
  assertCallerCurrent?: () => void,
) {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertCallerCurrent?.();
  };
  const captured = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  if (!captured) {
    return undefined;
  }
  const { owner, authority, agentId } = captured;
  const binding =
    captured.binding?.agentId === agentId && captured.binding.path === captured.path
      ? captured.binding
      : undefined;
  const identity =
    owner?.identity ??
    (binding?.agentId === agentId && binding.path === captured.path
      ? binding.actor.target.database
      : undefined);
  const source: CapturedSessionEntryReadSource | undefined =
    identity?.kind === "memory"
      ? { agentId, path: captured.path, databaseIdentity: identity.incarnation }
      : undefined;
  return {
    source,
    agentId,
    path: captured.path,
    read(sessionKey: string, projection?: SessionEntryProjection) {
      const entry = readCapturedSessionActorEntry(
        captured,
        resolveSqliteSessionKey(sessionKey, agentId),
      );
      return entry && attachSessionEntrySnapshots(entry, {}, projection);
    },
    readById(sessionId: string, projection?: SessionEntryProjection, orderBy?: "updatedAt") {
      const selected = owner
        ? owner.readSessionById(sessionId, authority, { currentOnly: true, orderBy })
        : binding?.actor.storage?.readCurrent(
            { type: "session.entry.readById", input: { sessionId, currentOnly: true } },
            authority,
          );
      return (
        selected && {
          sessionKey: selected.sessionKey,
          entry: attachSessionEntrySnapshots(selected.entry, {}, projection),
        }
      );
    },
    entries(projection?: SessionEntryProjection) {
      if (owner) {
        return owner.listSessionEntries(authority, projection);
      }
      return (
        binding?.actor.storage?.readCurrent(
          { type: "session.entries.read", input: { projection } },
          authority,
        ) ?? []
      );
    },
    facts(sessionKey: string) {
      if (owner) {
        const state = owner.readSession(sessionKey, authority);
        return { members: state?.members ?? [], participants: state?.participants ?? [] };
      }
      if (binding?.actor.target.sessionKey !== sessionKey) {
        return { members: [], participants: [] };
      }
      return {
        members:
          binding.actor.storage?.readCurrent({ type: "session.members.read", input: {} }, authority)
            .members ?? [],
        participants:
          binding.actor.storage?.readCurrent(
            { type: "session.participants.read", input: {} },
            authority,
          ) ?? [],
      };
    },
    assertCurrent() {
      owner?.assertCurrent();
      if (!owner && binding) {
        binding.actor.assertReadable();
      }
      authority.assertCurrent();
    },
  };
}

export function assertMemoryExactReadSource(
  expected: CapturedSessionEntryReadSource | undefined,
  actual: CapturedSessionEntryReadSource | undefined,
): void {
  if (
    expected &&
    (!actual ||
      expected.agentId !== actual.agentId ||
      path.resolve(expected.path) !== path.resolve(actual.path) ||
      expected.databaseIdentity !== actual.databaseIdentity)
  ) {
    throw new Error("Captured session database changed before read");
  }
}
