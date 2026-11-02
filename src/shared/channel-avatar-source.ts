type ChannelAvatarOrigin = {
  provider?: string;
  accountId?: string;
  chatType?: string;
  from?: string;
  nativeDirectUserId?: string;
};

type NativeSenderAvatarScope = {
  pluginId?: string | null;
  accountId?: string | null;
  id?: string | null;
};

/** Compare existing channel facts for display only; never create a profile association. */
export function matchesChannelAvatarSenderSource(
  origin: ChannelAvatarOrigin | undefined,
  sender: NativeSenderAvatarScope,
): boolean {
  return Boolean(
    sender.pluginId &&
    sender.accountId &&
    sender.id &&
    origin?.chatType === "direct" &&
    origin.provider === sender.pluginId &&
    origin.accountId === sender.accountId &&
    (origin.nativeDirectUserId
      ? origin.nativeDirectUserId === sender.id
      : origin.from === sender.pluginId + ":" + sender.id),
  );
}
