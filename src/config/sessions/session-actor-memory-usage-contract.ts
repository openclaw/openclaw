import type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { SessionTranscriptStats } from "./session-accessor.types.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "./session-memory-targets.types.js";

/** Replaced as a unit; readers retain the immutable envelope and body together. */
type SessionActorMemoryUsageRollup = {
  valueJson: string;
  blob: Uint8Array;
  updatedAt: number;
};

export type SessionActorMemoryUsageSnapshot = {
  sessionKey: string;
  sessionId: string;
  updatedAtMs: number;
  stats: SessionTranscriptStats;
  rollup?: Omit<SessionActorMemoryUsageRollup, "blob"> & { blob?: Uint8Array };
  events?: Array<{ seq: number; eventJson: string }>;
};

export type SessionActorMemoryUsageReads = {
  "session.memory.targets": {
    input: { selectors: MemorySessionSelectors };
    output: MemorySessionTarget[];
  };
  "session.corpus.list": {
    input: { options: SessionTranscriptCorpusOptions };
    output: SessionTranscriptCorpusEntry[];
  };
  "session.usage.snapshot": {
    input: {
      includeEvents?: boolean;
      includeRollupBodies?: boolean;
      sessionIds?: readonly string[];
    };
    output: SessionActorMemoryUsageSnapshot[];
  };
};

export type SessionActorMemoryUsageWrites = {
  "session.usage.write": {
    input: { sessionId: string; rollup: SessionActorMemoryUsageRollup };
    output: boolean;
  };
};
