import path from "node:path";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";

/** An exact reader borrows the selected owner; absence never opens or acquires a backend. */
export function captureMemoryExactSessionReader(scope: {
  agentId?: string;
  storePath?: string;
  sessionKey?: string;
  sessionActor?: SessionActorStorageBinding;
}) {
  if (scope.sessionKey && !isIncognitoSessionKey(scope.sessionKey) && !scope.sessionActor) {
    return undefined;
  }
  const selected = getSessionActorStorageBinding({ sessionActor: scope.sessionActor });
  if (!selected) {
    return undefined;
  }
  if (scope.sessionActor) {
    getSessionActorStorageBinding(scope);
  }
  const agentId =
    scope.agentId ?? parseAgentSessionKey(scope.sessionKey ?? "")?.agentId ?? selected.agentId;
  if (agentId === selected.agentId) {
    getSessionActorStorageBinding({ ...scope, sessionKey: undefined });
    const source: CapturedSessionEntryReadSource = {
      agentId,
      path: selected.path,
      databaseIdentity: selected.actor.target.database.incarnation,
    };
    return {
      source,
      read(sessionKey: string, projection?: SessionEntryProjection) {
        return selected.actor.storage.readCurrent(
          { type: "session.entry.read", input: { sessionKey, projection } },
          selected.authority,
        );
      },
      entries(projection?: SessionEntryProjection) {
        return selected.actor.storage.readCurrent(
          { type: "session.entries.read", input: { projection } },
          selected.authority,
        );
      },
      assertCurrent() {
        selected.actor.assertReadable();
        selected.authority.assertCurrent();
      },
    };
  }
  const captured = captureSessionActorStorageOwner({ ...scope, agentId })!;
  const owner = captured.owner;
  return {
    source: owner
      ? { agentId, path: owner.path, databaseIdentity: owner.identity.incarnation }
      : undefined,
    read(sessionKey: string, projection?: SessionEntryProjection) {
      const entry = owner?.readSession(sessionKey, captured.authority)?.entry;
      return entry && attachSessionEntrySnapshots(entry, {}, projection);
    },
    entries(projection?: SessionEntryProjection) {
      return (owner?.listSessions(captured.authority) ?? []).flatMap((state) =>
        state.entry
          ? [
              {
                sessionKey: state.target.sessionKey,
                entry: attachSessionEntrySnapshots(state.entry, {}, projection),
              },
            ]
          : [],
      );
    },
    assertCurrent() {
      selected.actor.assertReadable();
      captured.authority.assertCurrent();
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
