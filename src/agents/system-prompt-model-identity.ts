/** The current-model identity line, rendered in Runtime and kept current after hook rewrites. */
const MODEL_IDENTITY_PREFIX = "Current model identity:";

export function buildModelIdentityPromptLine(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  return `${MODEL_IDENTITY_PREFIX} ${trimmed}. If asked what model you are, answer with this value for the current run.`;
}

export function appendModelIdentitySystemPrompt(params: {
  systemPrompt: string;
  model?: string;
}): string {
  const line = buildModelIdentityPromptLine(params.model);
  if (!line) {
    return params.systemPrompt;
  }

  const source = params.systemPrompt;
  const parts: string[] = [];
  let cursor = 0;
  for (let index = source.indexOf(MODEL_IDENTITY_PREFIX); index !== -1;) {
    const nextLine = source.indexOf("\n", index);
    const lineStart = source.lastIndexOf("\n", index) + 1;
    if (!source.slice(lineStart, index).trimStart()) {
      // Normalize only original bytes; replacement model text can itself contain CRLFs.
      const preceding = source.slice(cursor, lineStart).replace(/\r\n/gu, "\n");
      if (parts.length === 0) {
        parts.push(preceding, line);
      } else {
        // Dropping a duplicate line also drops its preceding normalized LF.
        parts.push(preceding.slice(0, -1));
      }
      cursor = nextLine === -1 ? source.length : nextLine;
    }
    // A later occurrence on the same line cannot have a whitespace-only prefix.
    index = nextLine === -1 ? -1 : source.indexOf(MODEL_IDENTITY_PREFIX, nextLine + 1);
  }
  if (parts.length > 0) {
    parts.push(source.slice(cursor).replace(/\r\n/gu, "\n"));
    return parts.join("");
  }

  const base = params.systemPrompt.trimEnd();
  return base ? `${base}\n\n${line}` : line;
}
