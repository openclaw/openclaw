const LOOP_DONE_SENTINEL_REGEX = /\r?\n?\s*LOOP_DONE\s*$/i;

export function sanitizeAssistantText(raw: string): string {
  // Match both complete tags (<final>, </final>) and partial streaming tags (<final, </final)
  let text = raw.replace(/<\/?final>?/g, "");
  while (LOOP_DONE_SENTINEL_REGEX.test(text)) {
    text = text.replace(LOOP_DONE_SENTINEL_REGEX, "");
  }
  return text;
}

export function mergeAssistantTextBuffer(previous: string, incoming: string): string {
  const prev = previous;
  const next = incoming;
  if (!next.trim()) {
    return prev;
  }
  if (!prev.trim()) {
    return next;
  }
  // Some providers emit full snapshots; others emit chunk deltas.
  if (next.startsWith(prev)) {
    return next;
  }
  if (prev.endsWith(next)) {
    return prev;
  }

  // Handle "corrected snapshot" chunks where the model revises recent tokens:
  // e.g. prev="There'" -> next="There's".
  const prefixLimit = Math.min(prev.length, next.length);
  let commonPrefix = 0;
  while (commonPrefix < prefixLimit && prev[commonPrefix] === next[commonPrefix]) {
    commonPrefix += 1;
  }
  if (next.length >= prev.length && commonPrefix >= Math.max(4, Math.floor(prev.length * 0.6))) {
    return next;
  }

  // Join by maximal suffix/prefix overlap to avoid duplicated fragments.
  const overlapLimit = Math.min(prev.length, next.length);
  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    if (prev.slice(-overlap) === next.slice(0, overlap)) {
      return `${prev}${next.slice(overlap)}`;
    }
  }
  return `${prev}${next}`;
}
