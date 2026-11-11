import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { isIncognitoSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";

type IncognitoSessionSharingTarget = {
  agentId?: string;
  sessionKey: string;
  resolved: { readSource?: { path: string }; storePath: string } | null;
  absentTarget?: { storePath: string };
};

export class SessionMutationFactsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session access facts are unavailable; retry after session storage is ready.", options);
    this.name = "SessionMutationFactsUnavailableError";
  }
}

/** Capture only existing memory state; the caller owns disclosure and effect authorization. */
export function captureSessionSharingMemoryFacts(
  target: IncognitoSessionSharingTarget,
  assertCurrent: () => void,
  allowMissing = true,
) {
  if (!isIncognitoSessionKey(target.sessionKey)) {
    return undefined;
  }
  const authority = { assertCurrent, authorize: assertCurrent };
  const captured = captureSessionActorStorageOwner(
    {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath:
        target.resolved?.readSource?.path ??
        target.resolved?.storePath ??
        target.absentTarget?.storePath,
    },
    authority,
  );
  if (!captured) {
    throw new SessionMutationFactsUnavailableError();
  }
  const { agentId, path } = captured;
  let owner = captured.owner;
  const canonicalKey = toAgentStoreSessionKey({ agentId, requestKey: target.sessionKey });
  const location = { agentId, path };
  const readCurrent = () => {
    assertCurrent();
    captured.binding?.actor.assertReadable();
    // A creation admission may precede its owner; pin the first owner it observes.
    owner ??= memorySessionActorOwners.read(location);
    const current = owner?.readSession(canonicalKey, captured.authority);
    if (!current?.entry) {
      if (!allowMissing) {
        throw new SessionMutationFactsUnavailableError();
      }
      return { target: null, members: [], membership: new Set<string>() };
    }
    return {
      sourcePath: path,
      sourceAgentId: agentId,
      target: {
        agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: [canonicalKey],
        storePath: path,
        readSource: undefined,
        entry: current.entry,
      },
      members: current.members,
      membership: new Set(current.members.map((member) => member.identityId)),
    };
  };
  return {
    location,
    assertCurrent: () => void readCurrent(),
    readCurrent,
  };
}

/** Synchronous callers receive detached facts, never a retained authority or a new owner. */
export function readSessionSharingMemoryFacts(target: IncognitoSessionSharingTarget) {
  let active = true;
  try {
    const facts = captureSessionSharingMemoryFacts(target, () => {
      if (!active) {
        throw new SessionMutationFactsUnavailableError();
      }
    });
    return facts && { ...facts.readCurrent(), location: facts.location };
  } finally {
    active = false;
  }
}
