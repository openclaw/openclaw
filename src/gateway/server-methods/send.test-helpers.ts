export function messageActionContextFromSessionKeyForTests(sessionKey: string): {
  expiresAtMs: number;
  toolContext?: {
    currentChannelProvider?: string;
    currentChannelId?: string;
    currentChatType?: "direct" | "group" | "channel";
  };
} {
  const parts = sessionKey.split(":");
  const provider = parts[2];
  const peerKind = parts[3];
  const peerId = parts.slice(4).join(":");
  const currentChatType =
    peerKind === "direct" || peerKind === "dm"
      ? "direct"
      : peerKind === "group" || peerKind === "channel"
        ? peerKind
        : undefined;
  return {
    expiresAtMs: Date.now() + 60_000,
    toolContext:
      provider && peerId
        ? {
            currentChannelProvider: provider,
            currentChannelId: peerId,
            currentChatType,
          }
        : undefined,
  };
}
