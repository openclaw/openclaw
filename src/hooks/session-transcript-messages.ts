import fs from "node:fs/promises";

/**
 * Read messages from a session JSONL transcript file, preserving all fields
 * including `provenance`. Returns `null` if the file is unavailable or
 * unreadable so callers can fall back to an in-memory snapshot.
 */
export async function readMessagesFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<unknown[] | null> {
  if (!sessionFile) {
    return null;
  }
  try {
    const content = await fs.readFile(sessionFile, "utf-8");
    const messages: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return null;
  }
}
