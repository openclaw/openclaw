import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope-helpers.js";

export type TranscriptPageReadLimits = {
  limit: number;
  maxScannedEntries: number;
  maxMaterializedBytes: number;
};

export type TranscriptReadAccounting = {
  scannedEntries: number;
  materializedBytes: number;
  exhausted: boolean;
  final: boolean;
};

export type TranscriptReadMeter = {
  readonly limits: Readonly<TranscriptPageReadLimits>;
  reserve: (
    entries: number,
    bytes: number,
  ) => { observe: (entries: number, bytes: number) => void } | undefined;
  snapshot: (final: boolean) => TranscriptReadAccounting;
};

export type TranscriptPageReadPosition = {
  sessionId: string;
  lifecycleRevision: string;
  generation: string;
  frontier: number;
  lastSeq: number;
};

export type TranscriptPageReadRequest = {
  scope: ResolvedTranscriptScope;
  expectedLifecycleRevision: string;
  limits: TranscriptPageReadLimits;
  position?: TranscriptPageReadPosition;
};

export type TranscriptPageReadFailure =
  | "unsupported"
  | "missing"
  | "forbidden"
  | "invalid_cursor"
  | "stale_session"
  | "resource_limit"
  | "timed_out"
  | "read_failed";

export type TranscriptPageReadResult = (
  | {
      ok: true;
      value: {
        generation: string;
        records: {
          storedEntryId: string;
          event: unknown;
          beforePosition: TranscriptPageReadPosition;
          afterPosition: TranscriptPageReadPosition;
        }[];
        nextPosition?: TranscriptPageReadPosition;
      };
    }
  | { ok: false; error: TranscriptPageReadFailure }
) & { budget: TranscriptReadAccounting };
