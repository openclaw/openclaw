export function findCliAnnounceReplyIndexes(
  assistantReplies: readonly string[],
  parentToken: string,
  childToken: string,
) {
  const parentReplyIndex = assistantReplies.findIndex((reply) => reply.includes(parentToken));
  // A native CLI invocation can retain several visible messages in one canonical
  // row. An early mention of the child is not the later completion handoff.
  const completionReplyIndex = assistantReplies.findIndex(
    (reply, index) => index > parentReplyIndex && reply.includes(childToken),
  );
  return { parentReplyIndex, completionReplyIndex };
}
