import { formatByteSize } from "@openclaw/normalization-core";

// Media files remain readable by sandbox container UIDs; the private media
// directory is the trust boundary. Temp and final writes must use one mode.
export const MEDIA_FILE_MODE = 0o644;

export function formatMediaSize(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: "",
    fractionDigits: (value) => (Number.isInteger(value) ? 0 : 2),
  });
}

export function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMediaSize(cap)} limit (got ${formatMediaSize(size)})`;
}

export function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMediaSize(cap)} (got ${formatMediaSize(size)})`;
}

/** Stable error categories for unsafe or failed source-file ingestion. */
type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

/** Media persistence failure with a stable category for callers. */
export class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;
  /** Byte size of the rejected source, when the reader knew it before refusing it. */
  readonly sizeBytes?: number;
  /** Byte limit that rejected the source. */
  readonly maxBytes?: number;

  constructor(
    code: SaveMediaSourceErrorCode,
    message: string,
    options?: ErrorOptions & MediaSizeFacts,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.name = "SaveMediaSourceError";
    const sizeBytes = readByteCount(options?.sizeBytes);
    const maxBytes = readByteCount(options?.maxBytes);
    if (sizeBytes !== undefined) {
      this.sizeBytes = sizeBytes;
    }
    if (maxBytes !== undefined) {
      this.maxBytes = maxBytes;
    }
  }

  static tooLarge(
    maxBytes: number,
    options?: ErrorOptions & Pick<MediaSizeFacts, "sizeBytes">,
  ): SaveMediaSourceError {
    const limit = formatMediaSize(maxBytes);
    const sizeBytes = readByteCount(options?.sizeBytes);
    const got = sizeBytes === undefined ? "" : ` (got ${formatMediaSize(sizeBytes)})`;
    return new SaveMediaSourceError("too-large", `Media exceeds ${limit} limit${got}`, {
      ...options,
      maxBytes,
    });
  }
}

/** Size rejection naming the source kind, the limit, and the rejected size. */
export function mediaCapExceededError(
  label: string,
  cap: number,
  size: number,
): SaveMediaSourceError {
  return new SaveMediaSourceError("too-large", formatCapLimit(label, cap, size), {
    sizeBytes: size,
    maxBytes: cap,
  });
}

/** Byte facts carried by a size-limit rejection so callers can explain it without re-reading the source. */
export type MediaSizeFacts = {
  sizeBytes?: number;
  maxBytes?: number;
};

function readByteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readByteField(source: unknown, key: keyof MediaSizeFacts): number | undefined {
  return source !== null && typeof source === "object"
    ? readByteCount(Reflect.get(source, key))
    : undefined;
}

/**
 * Reads the first size and limit recorded along an error's cause chain.
 * Media errors carry them as fields; fs-safe errors carry them in `details`.
 */
export function readMediaSizeFacts(error: unknown): MediaSizeFacts {
  const facts: MediaSizeFacts = {};
  let current: unknown = error;
  // Bounded like the failure classifier so malformed cause cycles stay safe.
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const details: unknown = Reflect.get(current, "details");
    facts.sizeBytes ??= readByteField(current, "sizeBytes") ?? readByteField(details, "sizeBytes");
    facts.maxBytes ??= readByteField(current, "maxBytes") ?? readByteField(details, "maxBytes");
    if (facts.sizeBytes !== undefined && facts.maxBytes !== undefined) {
      break;
    }
    current = current.cause;
  }
  return {
    ...(facts.sizeBytes !== undefined ? { sizeBytes: facts.sizeBytes } : {}),
    ...(facts.maxBytes !== undefined ? { maxBytes: facts.maxBytes } : {}),
  };
}
