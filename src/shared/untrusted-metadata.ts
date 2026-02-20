const UNTRUSTED_METADATA_HEADERS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

export function stripUntrustedMetadataBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!UNTRUSTED_METADATA_HEADERS.includes(line as (typeof UNTRUSTED_METADATA_HEADERS)[number])) {
      kept.push(line);
      continue;
    }
    if (lines[i + 1] !== "```json") {
      kept.push(line);
      continue;
    }
    i += 2;
    while (i < lines.length && lines[i] !== "```") {
      i += 1;
    }
  }
  return kept
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}
