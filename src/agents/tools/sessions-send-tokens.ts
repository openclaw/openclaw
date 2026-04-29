export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";

export function isAnnounceSkip(text?: string) {
  const t = (text ?? "").trim();
  return t === ANNOUNCE_SKIP_TOKEN || t.endsWith("\n" + ANNOUNCE_SKIP_TOKEN);
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}
