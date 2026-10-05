import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";

export type CliHistoryWriter = {
  target: SessionTranscriptRuntimeTarget;
  runId: string;
  authFingerprint: string;
  lifecycleRevision?: string;
  assertCurrent: () => void;
  assertReadable: () => void;
  /**
   * Fresh owner check, asked once per coverage commit. False keeps the commit's rows but
   * does not advance coverage. Absent means the owner cannot change during the run.
   */
  confirmsOwner?: () => boolean;
};

/** The writer as the executing run holds it; workers only ever see the base capability. */
export type CliExecutionHistoryWriter = CliHistoryWriter & {
  /** True when ownership comes from a native login resolved from the child environment. */
  bindsNativeLogin: boolean;
  /**
   * Fresh native login check for a spawn or prompt send. A changed or unresolvable login
   * refuses a recovery turn and stops coverage for any other turn.
   */
  checkNativeLoginBoundary: (recovering: boolean) => void;
  /** Resolve the native login owner from the environment execution actually spawns with. */
  bindExecutionEnv: (env: NodeJS.ProcessEnv, recovering: boolean) => void;
  /** False when this turn must run without saved history; coverage still applies. */
  replaysHistory: boolean;
  /**
   * After the child exits and before its rows commit: attest any credential the run
   * rotated to. Never rejects; a login it cannot attest to the owner stops coverage.
   */
  settleNativeLogin: () => Promise<void>;
};

const cliHistoryWriter = new AsyncLocalStorage<CliHistoryWriter>();

export function runWithCliHistoryWriter<T>(writer: CliHistoryWriter | undefined, run: () => T): T {
  return writer ? cliHistoryWriter.run(writer, run) : cliHistoryWriter.exit(run);
}

/** The serializable account facts a worker needs to advance coverage for this writer. */
export function cliHistoryWriterFacts(
  writer: CliHistoryWriter,
): Pick<CliHistoryWriter, "runId" | "authFingerprint" | "lifecycleRevision"> {
  return {
    runId: writer.runId,
    authFingerprint: writer.authFingerprint,
    lifecycleRevision: writer.lifecycleRevision,
  };
}

/** Hosts dispatching a worker commit hand it account facts only while the owner still holds. */
export function resolveCliHistoryCoverageWriter(
  writer: CliHistoryWriter | undefined,
): Pick<CliHistoryWriter, "runId" | "authFingerprint" | "lifecycleRevision"> | undefined {
  return writer && writer.confirmsOwner?.() !== false ? cliHistoryWriterFacts(writer) : undefined;
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
