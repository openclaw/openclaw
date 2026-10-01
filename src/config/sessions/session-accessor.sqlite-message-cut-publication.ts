export type SessionMessageForkPublication = {
  kind: "session-message-forked";
  key: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceSessionId: string;
  databaseIdentity: string;
};

/** Suppress a stale create event when a later native write superseded the fork target. */
export function selectCommittedForkIdentityPublication(
  fork: SessionMessageForkPublication | undefined,
  isCurrent: (key: string) => boolean,
) {
  return fork && isCurrent(fork.key)
    ? {
        previous: new Map(),
        current: new Map([
          [fork.key, { sessionId: fork.sessionId, lifecycleRevision: fork.lifecycleRevision }],
        ]),
      }
    : undefined;
}
