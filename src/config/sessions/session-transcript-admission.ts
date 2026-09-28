import { isDeepStrictEqual } from "node:util";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { bindSessionTranscriptStoreScope } from "./session-accessor.transcript-target.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  SessionTranscriptAdmissionRead,
  SessionTranscriptEligibleEntry,
  SessionTranscriptResetBoundary,
} from "./session-transcript-admission.types.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";
import type { TranscriptTurnBoundary } from "./transcript-entry-anchor.js";

export type SessionTranscriptAdmissionTarget = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
}>;

declare const snapshotToken: unique symbol;
/** Process-local, one-use admission capability. Never persist or serialize it. */
export type SessionTranscriptAdmissionToken = Readonly<{ [snapshotToken]: true }>;

export type SessionTranscriptAdmissionSnapshot = Readonly<{
  kind: "snapshot";
  entries: readonly SessionTranscriptEligibleEntry[];
  generation: string | null;
  boundary: SessionTranscriptResetBoundary | null;
  token: SessionTranscriptAdmissionToken;
}>;
export type SessionTranscriptAdmissionResult =
  | SessionTranscriptAdmissionSnapshot
  | { kind: "missing" | "stale" };

type PreparedTarget = {
  target: SessionTranscriptRuntimeTarget;
  options: ReturnType<typeof toDatabaseOptions>;
};
type CapturedSnapshot = PreparedTarget & {
  admission: ReturnType<typeof resolveSessionTranscriptReadFence>;
  assertHostCurrent: () => void;
  facts: Omit<Extract<SessionTranscriptAdmissionRead, { kind: "snapshot" }>, "entries">;
};
const snapshots = new WeakMap<SessionTranscriptAdmissionToken, CapturedSnapshot>();

async function prepareTarget(target: SessionTranscriptAdmissionTarget): Promise<PreparedTarget> {
  const bound = bindSessionTranscriptStoreScope({ ...target });
  const resolved = await prepareSqliteTranscriptReadScope(bound);
  const options = toDatabaseOptions(resolved);
  return {
    options,
    target: {
      ...bound,
      agentId: resolved.agentId,
      storePath: resolveOpenClawAgentSqlitePath(options),
    },
  };
}

async function readSnapshot(
  owner: SessionHistoryWorkerDatabase,
  target: SessionTranscriptRuntimeTarget,
  admission: CapturedSnapshot["admission"],
  includeEntries: boolean,
  turn?: TranscriptTurnBoundary,
) {
  try {
    return await owner.readAdmission({ target, admission, includeEntries, turn });
  } catch (error) {
    if (error instanceof SessionTranscriptReadFenceError) {
      return { kind: "stale" } as const;
    }
    // Storage/corruption/worker failures are unavailable reads, never empty snapshots.
    throw error;
  }
}

/** One canonical, reset-only read; archive and host model-context APIs are unchanged. */
export async function readSessionTranscriptAdmission(
  target: SessionTranscriptAdmissionTarget,
): Promise<SessionTranscriptAdmissionResult> {
  const host = captureOpenClawStateReadContext();
  const assertHostCurrent = () => host.admission.assertCurrent();
  assertHostCurrent();
  const admission = resolveSessionTranscriptReadFence(target);
  const prepared = await prepareTarget(target);
  const { withSessionHistoryWorkerDatabase } =
    await import("./session-transcript-worker-runtime.js");
  const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
  return withSessionHistoryWorkerDatabase(prepared.options, async (owner) => {
    const result = await readRestoredSessionTranscript(
      prepared.target,
      () => readSnapshot(owner, prepared.target, admission, true),
      {
        assertCurrent: () => {
          assertHostCurrent();
          owner.assertCurrent();
        },
      },
    );
    assertHostCurrent();
    owner.assertCurrent();
    if (result.kind !== "snapshot") {
      return result;
    }
    const { entries, ...facts } = result;
    const token = Object.freeze({}) as SessionTranscriptAdmissionToken;
    snapshots.set(token, {
      ...prepared,
      admission,
      assertHostCurrent,
      facts,
    });
    return {
      kind: "snapshot",
      entries,
      generation: facts.version.generation ?? null,
      boundary: structuredClone(facts.boundary),
      token,
    };
  });
}

/**
 * Own canonical host writes until plugin persistence settles. Prepare outside this
 * callback; commit only plugin-owned state inside it, awaiting every effect.
 * Host session writes need this same queue and must not run inside the callback.
 * A rejection propagates; the host never retries a possibly committed plugin write.
 */
export async function acceptSessionTranscriptAdmission<T>(
  token: SessionTranscriptAdmissionToken,
  commit: (boundary: SessionTranscriptResetBoundary | null) => Promise<T> | T,
): Promise<{ kind: "accepted"; value: T } | { kind: "stale" }> {
  const captured = snapshots.get(token);
  snapshots.delete(token);
  if (!captured) {
    return { kind: "stale" };
  }
  captured.assertHostCurrent();
  return withTranscriptAcceptanceOwner(captured, async (owner) => {
    const current = await readSnapshot(owner, captured.target, captured.admission, false);
    captured.assertHostCurrent();
    owner.assertCurrent();
    if (current.kind !== "snapshot") {
      return { kind: "stale" };
    }
    const { entries: _entries, ...facts } = current;
    if (!isDeepStrictEqual(facts, captured.facts)) {
      return { kind: "stale" };
    }
    return { kind: "accepted", value: await commit(structuredClone(facts.boundary)) };
  });
}

async function withTranscriptAcceptanceOwner<T>(
  prepared: PreparedTarget,
  run: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
): Promise<T> {
  const { withSessionHistoryWorkerDatabase } =
    await import("./session-transcript-worker-runtime.js");
  return withSessionHistoryWorkerDatabase(prepared.options, (owner) =>
    runOpenClawAgentWriteAdmission(prepared.options, async (_identity, assertPathCurrent) => {
      owner.assertCurrent();
      assertPathCurrent();
      return run(owner);
    }),
  );
}

/** Durable outbox replay uses the same acceptance owner, not a later reset hook. */
export async function acceptSessionTranscriptTurn<T>(
  turn: TranscriptTurnBoundary,
  commit: (boundary: SessionTranscriptResetBoundary | null) => Promise<T> | T,
): Promise<{ kind: "accepted"; value: T } | { kind: "stale" }> {
  const prepared = await prepareTarget(turn.admission);
  return withTranscriptAcceptanceOwner(prepared, async (owner) => {
    // Outbox delivery is independent of the currently assembling turn's history fence.
    const current = await readSnapshot(owner, prepared.target, undefined, false, turn);
    owner.assertCurrent();
    if (current.kind !== "snapshot") {
      return { kind: "stale" };
    }
    return { kind: "accepted", value: await commit(current.boundary) };
  });
}
