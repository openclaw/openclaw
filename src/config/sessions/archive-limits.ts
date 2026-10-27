/**
 * Disk budget for one streamed archive materialization.
 *
 * This is not a compatibility boundary and not a string limit: decoding streams
 * straight to the read cache, so memory never scales with the archive. What the
 * cap protects is cache-directory growth, which is why it sits far above any
 * archive the product writes (writers bound encoded bytes at 64 MiB) and why it
 * is not reused by the synchronous string reader, which has its own runtime
 * ceiling and must keep accepting anything it accepted before.
 *
 * Do not raise this past 4 GiB: runtimes reject a larger zstd `maxOutputLength`
 * outright (`ERR_OUT_OF_RANGE`), and the stream counter feeds the same option.
 */
export const MAX_SESSION_ARCHIVE_STREAM_BYTES = 4 * 1024 * 1024 * 1024;

/** Raised when streamed decoding would exceed the materialization budget. */
export class SessionArchivePlaintextLimitError extends Error {
  readonly storedBytes: number;
  readonly limitBytes: number;

  constructor(params: {
    source?: string;
    storedBytes: number;
    limitBytes: number;
    cause?: unknown;
  }) {
    const source = params.source ? ` ${params.source}` : "";
    super(
      `Session archive${source} expands past the ${formatLimit(params.limitBytes)} cache budget ` +
        `(${params.storedBytes} stored bytes). Decoding stopped before anything was written and the ` +
        `archive itself is unchanged; export the session again, or move the archive out of the ` +
        `sessions directory, to read it.`,
      { cause: params.cause },
    );
    this.name = "SessionArchivePlaintextLimitError";
    this.storedBytes = params.storedBytes;
    this.limitBytes = params.limitBytes;
  }
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024 * 1024))} GiB`;
  }
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} bytes`;
}
