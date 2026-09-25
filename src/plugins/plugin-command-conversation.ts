/** Host-created invocation metadata; no storage, route mutation, or fork authority. */
type CommandConversation = Readonly<{
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}>;

export function createCommandConversationReader(params: {
  conversation: CommandConversation | null;
  isAuthorizedSender: boolean;
  signal: AbortSignal;
  isRegistryCurrent: () => boolean;
}): () => CommandConversation | null {
  // Capture primitives and callbacks, not mutable command/plugin context objects.
  const { signal, isRegistryCurrent, isAuthorizedSender } = params;
  const source = params.conversation;
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.trim() === value;
  const conversation =
    source &&
    valid(source.channel) &&
    valid(source.accountId) &&
    valid(source.conversationId) &&
    (source.parentConversationId === undefined || valid(source.parentConversationId))
      ? Object.freeze({
          channel: source.channel,
          accountId: source.accountId,
          conversationId: source.conversationId,
          ...(source.parentConversationId === undefined
            ? {}
            : { parentConversationId: source.parentConversationId }),
        })
      : null;
  return () => {
    if (!isAuthorizedSender || signal.aborted || !isRegistryCurrent()) {
      return null;
    }
    return conversation;
  };
}
