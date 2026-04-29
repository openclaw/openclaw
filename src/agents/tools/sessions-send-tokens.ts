export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";

// Sub-agents commonly emit a brief summary block followed by `ANNOUNCE_SKIP`
// on the final line to opt out of inter-session announcement while keeping
// the body for the local transcript. Strict equality on the whole trimmed
// text only matches when the model emits *just* the token, so realistic
// multi-line outputs ending with `\nANNOUNCE_SKIP` defeat fire-and-forget
// semantics and leak the entire summary to the parent session. Accept both
// shapes: the canonical lone-token form, and the standalone-final-line form.
// See #74071. `REPLY_SKIP` semantics intentionally remain strict equality to
// avoid widening the user-reply suppression contract without explicit review.
export function isAnnounceSkip(text?: string) {
  const trimmed = (text ?? "").trim();
  if (trimmed === ANNOUNCE_SKIP_TOKEN) {
    return true;
  }
  return trimmed.endsWith(`\n${ANNOUNCE_SKIP_TOKEN}`);
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}
