declare const chatRefBrand: unique symbol;

/**
 * The only durable address of a chat. The key survives edits, resets, compaction and
 * rollover; a transcript id or lifecycle revision does not, so a `ChatRef` carries neither.
 */
export type ChatRef = Readonly<{ agentId: string; storePath: string; sessionKey: string }> & {
  readonly [chatRefBrand]: true;
};

/** Copies only the address, so ids from an old stored row never travel with it. */
export function chatRef(value: {
  agentId: string;
  storePath: string;
  sessionKey: string;
}): ChatRef {
  const address = Object.freeze({
    agentId: value.agentId,
    storePath: value.storePath,
    sessionKey: value.sessionKey,
  });
  // SAFETY: the brand marks a value built here from exactly these three fields.
  return address as ChatRef;
}
