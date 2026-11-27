import { createHash } from "node:crypto";
import type { MediaUnderstandingOutput } from "../../packages/media-understanding-common/src/types.js";

// This cache owns only completed transcript values, never account admission,
// media paths, or provider credentials. Pending work counts toward the bound.
const MAX_ENTRIES = 64;
const MAX_RESULT_BYTES = 64 * 1024;
const RESULT_TTL_MS = 15_000;
type Transcript = Readonly<Omit<MediaUnderstandingOutput, "attachmentIndex">>;
type Entry = { result: Promise<Transcript | null>; expiresAt: number };
// Active runtime config objects are publication identities, shared by account
// handlers. A new config generation must never inherit old transcript results.
const generations = new WeakMap<object, Map<string, Entry>>();

/** Digest prepared equivalence facts without retaining their credential-bearing source. */
export function audioTranscriptionFingerprint(facts: unknown, audio: Uint8Array): string {
  return createHash("sha256")
    .update(JSON.stringify(facts))
    .update("\0")
    .update(audio)
    .digest("hex");
}

/**
 * Only service-owned computation may join: callers validate their own input and
 * policy first. A caller-owned cancellation/authority fence must not be borrowed
 * by another account. Returned values are frozen and contain no caller index.
 */
export async function shareAudioTranscription(
  generation: object,
  key: string,
  transcribe: () => Promise<MediaUnderstandingOutput | null>,
): Promise<Transcript | null> {
  let transcripts = generations.get(generation);
  if (!transcripts) {
    transcripts = new Map();
    generations.set(generation, transcripts);
  }
  const entries = transcripts;
  const now = Date.now();
  for (const [entryKey, entry] of entries) {
    if (entry.expiresAt <= now) {
      transcripts.delete(entryKey);
    }
  }
  const existing = transcripts.get(key);
  if (existing) {
    return existing.result;
  }
  // Do not evict pending work: that would launch duplicate transcription. A
  // saturated cache declines new sharing rather than growing without bound.
  if (transcripts.size >= MAX_ENTRIES) {
    const output = await transcribe();
    if (!output) {
      return null;
    }
    const { attachmentIndex: _, ...transcript } = output;
    return Object.freeze(transcript);
  }
  const entry: Entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve().then(async () => {
      try {
        const output = await transcribe();
        if (!output) {
          entries.delete(key);
          return null;
        }
        const { attachmentIndex: _, ...transcript } = output;
        if (Buffer.byteLength(JSON.stringify(transcript), "utf8") > MAX_RESULT_BYTES) {
          entries.delete(key);
        } else {
          entry.expiresAt = Date.now() + RESULT_TTL_MS;
        }
        return Object.freeze(transcript);
      } catch (error) {
        entries.delete(key);
        throw error;
      }
    }),
  };
  transcripts.set(key, entry);
  return entry.result;
}
