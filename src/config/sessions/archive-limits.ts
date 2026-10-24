/**
 * Upper bound for the decoded plaintext size of one archived session transcript.
 *
 * Transcript archives are written once and kept long term, so a truncated or
 * crafted `.zst` artifact can expand far past the size it occupies on disk.
 * Every archive reader decodes within this budget instead of trusting the
 * compressed byte count.
 *
 * Keep this aligned with the cold-tier envelope budget: both surfaces decode
 * the same archived transcripts and must fail closed on the same bound.
 */
export const MAX_SESSION_ARCHIVE_PLAINTEXT_BYTES = 64 * 1024 * 1024;

/** Raised when decoding an archive would exceed the plaintext budget. */
export class SessionArchivePlaintextLimitError extends Error {
  constructor(params: {
    source?: string;
    storedBytes: number;
    limitBytes: number;
    cause?: unknown;
  }) {
    const source = params.source ? ` ${params.source}` : "";
    super(
      `Session archive${source} expands past the ${formatLimit(params.limitBytes)} plaintext limit ` +
        `(${params.storedBytes} stored bytes); refusing to decode it.`,
      { cause: params.cause },
    );
    this.name = "SessionArchivePlaintextLimitError";
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} bytes`;
}
