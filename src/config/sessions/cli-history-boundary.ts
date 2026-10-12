import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { InternalSessionEntry } from "./types.js";

export type CliHistoryWriter = {
  target: SessionTranscriptRuntimeTarget;
  runId: string;
  authFingerprint: string;
  lifecycleRevision?: string;
  assertCurrent: () => void;
  assertReadable: () => void;
};

export type CliHistoryWriterFacts = Pick<
  CliHistoryWriter,
  "runId" | "authFingerprint" | "lifecycleRevision"
>;

const cliHistoryWriter = new AsyncLocalStorage<CliHistoryWriter>();

/** The transcript tip moved between CLI history planning and the writer's commit. */
export const CLI_HISTORY_CHANGED_BEFORE_PREPARATION = "CLI history changed before preparation";

export function runWithCliHistoryWriter<T>(writer: CliHistoryWriter | undefined, run: () => T): T {
  return writer ? cliHistoryWriter.run(writer, run) : cliHistoryWriter.exit(run);
}

export function getCliHistoryWriter(
  target: Partial<SessionTranscriptRuntimeTarget>,
): CliHistoryWriter | undefined {
  const writer = cliHistoryWriter.getStore();
  return writer &&
    writer.target.agentId === target.agentId &&
    writer.target.sessionId === target.sessionId &&
    writer.target.sessionKey === target.sessionKey &&
    writer.target.storePath === target.storePath
    ? writer
    : undefined;
}

/** Private proof of the account that owns every covered transcript event. */
export type CliHistoryBoundary =
  | { version: 1; sessionId: string; state: "unknown" }
  | {
      version: 1;
      sessionId: string;
      state: "known";
      authFingerprint: string;
      generation: string | null;
      maxSeq: number | null;
      writerRunId: string;
    };

export function isKnownCliHistoryBoundary(
  boundary: CliHistoryBoundary | undefined,
): boundary is Extract<CliHistoryBoundary, { state: "known" }> {
  return (
    boundary?.version === 1 &&
    boundary.state === "known" &&
    typeof boundary.sessionId === "string" &&
    boundary.sessionId.length > 0 &&
    typeof boundary.authFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(boundary.authFingerprint) &&
    (boundary.generation === null ||
      (typeof boundary.generation === "string" && boundary.generation.length > 0)) &&
    (boundary.maxSeq === null ||
      (boundary.generation !== null &&
        Number.isSafeInteger(boundary.maxSeq) &&
        boundary.maxSeq >= 0)) &&
    typeof boundary.writerRunId === "string" &&
    boundary.writerRunId.length > 0
  );
}

/** Advance only a contiguous prefix owned by the same prepared CLI account. */
export function advanceCliHistoryBoundary(
  entry: InternalSessionEntry | undefined,
  sessionId: string,
  generation: string | null,
  range: { first: number; last: number },
  writer: CliHistoryWriterFacts,
): InternalSessionEntry | undefined {
  const boundary = entry?.cliHistoryBoundary;
  if (
    range.last < range.first ||
    !entry ||
    !isKnownCliHistoryBoundary(boundary) ||
    entry.sessionId !== sessionId ||
    boundary.sessionId !== sessionId ||
    entry.activeWriterRunId !== writer.runId ||
    entry.lifecycleRevision !== writer.lifecycleRevision ||
    boundary.writerRunId !== writer.runId ||
    boundary.authFingerprint !== writer.authFingerprint ||
    (boundary.maxSeq === null ? range.first !== 0 : boundary.maxSeq !== range.first - 1) ||
    !generation ||
    (boundary.generation === null ? range.first !== 0 : boundary.generation !== generation)
  ) {
    return undefined;
  }
  return { ...entry, cliHistoryBoundary: { ...boundary, generation, maxSeq: range.last } };
}
