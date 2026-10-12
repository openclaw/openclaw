import { expectTypeOf, it } from "vitest";
import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
} from "../../packages/memory-host-sdk/src/host/session-files.js";
import type { SessionResetRecallCutoff } from "../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
} from "../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";

type MemorySessions = typeof import("./memory-core-host-engine-sessions.js");

it("retains released Memory reader signatures without internal actor sources", () => {
  expectTypeOf<Parameters<MemorySessions["buildSessionEntry"]>>().toEqualTypeOf<
    [string, BuildSessionEntryOptions?]
  >();
  expectTypeOf<ReturnType<MemorySessions["buildSessionEntry"]>>().toEqualTypeOf<
    Promise<SessionFileEntry | null>
  >();
  expectTypeOf<BuildSessionEntryOptions["onTranscriptMessage"]>().toEqualTypeOf<
    ((message: unknown, observedAt: number) => void) | undefined
  >();
  expectTypeOf<
    Parameters<MemorySessions["listSessionTranscriptCorpusEntriesForAgent"]>
  >().toEqualTypeOf<[string, SessionTranscriptCorpusOptions?]>();
  expectTypeOf<
    ReturnType<MemorySessions["listSessionTranscriptCorpusEntriesForAgent"]>
  >().toEqualTypeOf<Promise<SessionTranscriptCorpusEntry[]>>();
  expectTypeOf<Parameters<MemorySessions["readSessionResetRecallCutoff"]>>().toEqualTypeOf<
    [{ agentId: string; sessionId: string; sessionKey?: string; storePath: string }]
  >();
  expectTypeOf<ReturnType<MemorySessions["readSessionResetRecallCutoff"]>>().toEqualTypeOf<
    Promise<SessionResetRecallCutoff>
  >();
});
