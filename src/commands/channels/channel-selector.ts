export function parseChannelSelector(channel: string | undefined): string | undefined {
  // Only omission infers the channel. Blank input often comes from an unset shell
  // variable and must fail before channel setup, auth, or a directory lookup runs.
  if (channel !== undefined && !channel.trim()) {
    throw new Error("--channel must not be blank");
  }
  return channel;
}
