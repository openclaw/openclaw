export function resolveThreadBindingConversationIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): string | undefined {
  const bindingId = params.bindingId?.trim();
  if (!bindingId) {
    return undefined;
  }
  const prefix = `${params.accountId}:`;
  if (!bindingId.startsWith(prefix)) {
    return undefined;
  }
  const conversationId = bindingId.slice(prefix.length).trim();
  return conversationId || undefined;
}
