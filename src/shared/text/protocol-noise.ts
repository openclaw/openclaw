const LEAKED_PROTOCOL_LINE_RE = /^\s*(?:user|assistant)\s+(?:to=[a-z0-9_.:-]+|final)\b/i;
const FENCE_LINE_RE = /^\s*```/;

export function isLeakedProtocolLine(line: string): boolean {
  return LEAKED_PROTOCOL_LINE_RE.test(line);
}

export function stripLeakedProtocolLines(text: string): string {
  if (!text) {
    return text;
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  let removed = false;
  let inFence = false;

  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }

    if (!inFence && isLeakedProtocolLine(line)) {
      removed = true;
      continue;
    }

    kept.push(line);
  }

  if (!removed) {
    return text;
  }

  const joined = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  return joined.replace(/^\n+/, "").replace(/\n+$/, "");
}
