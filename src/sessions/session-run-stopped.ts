import { isUserInitiatedAgentRunAbortReason } from "../agents/run-termination.js";
import type { matchesSessionAbortTargetOwner } from "../config/sessions/session-accessor.entry-mutation.js";
import { resolveUserStoppedAt } from "../config/sessions/terminal-status.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookRunStoppedEvent } from "../plugins/hook-run-stopped.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { registerReplyOperationSuccessorBarrier } from "./session-controller.barriers.js";
import type { ReplyOperation, SessionControllerInput } from "./session-controller.contracts.js";
import { getSessionControllerSourceIdentity } from "./session-controller.identity.js";
import {
  getOperationSessionTarget,
  listOperationBackendRunIds,
} from "./session-controller.state.js";
import type { SessionControllerStopRunEffect } from "./session-controller.stop-capture.js";
import type { SessionStopSource } from "./session-controller.stop-source.types.js";

const log = createSubsystemLogger("sessions/stop");
const sessionAccessorLoader = createLazyImportLoader(
  () => import("../config/sessions/session-accessor.js"),
);

const EXPLICIT_RUN_STOP_SOURCES = new Set<SessionStopSource>([
  "channel-user",
  "client-session",
  "client-run",
]);

/** Stop sources that mean a user or operator stopped the run on purpose. */
type ExplicitRunStopSource = Extract<
  SessionStopSource,
  "channel-user" | "client-session" | "client-run"
>;

/** A stopped session, with the store and incarnation its Stop was authorized against. */
type StoppedSession = Readonly<{
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionId?: string;
}>;

/** One accepted explicit Stop: when it was accepted, and the sessions whose runs it stopped. */
export type SessionRunStopReceipt = Readonly<{
  stoppedAt: number;
  sessions: ReadonlyArray<StoppedSession>;
}>;

export function isExplicitRunStopSource(
  source: SessionStopSource,
): source is ExplicitRunStopSource {
  return EXPLICIT_RUN_STOP_SOURCES.has(source);
}

/**
 * Announces one explicit Stop of the given sessions' runs. Callers invoke it once per Stop, after
 * the Stop's live authority is confirmed and before cancellation commits, so a rejected Stop
 * announces nothing. Watchdog, restart, supersede and failure stops never call it.
 *
 * Consumers start synchronously, before the stopped runs' own completions can arrive, and can
 * never block or fail the Stop. The returned receipt is the Stop kernel's to record
 * (`recordSessionRunStopped`).
 */
export function notifySessionRunStopped(params: {
  source: ExplicitRunStopSource;
  sessions: Iterable<Partial<StoppedSession>>;
  runIds: Iterable<string>;
}): SessionRunStopReceipt {
  const stoppedAt = Date.now();
  const sessions = new Map<string, StoppedSession>();
  for (const { agentId, sessionKey, storePath, sessionId } of params.sessions) {
    if (agentId && sessionKey) {
      sessions.set(JSON.stringify([agentId, sessionKey]), {
        agentId,
        sessionKey,
        storePath,
        sessionId,
      });
    }
  }
  const event: PluginHookRunStoppedEvent = {
    source: params.source === "channel-user" ? "channel" : "client",
    // Plugins get the session identity, never its store or incarnation.
    sessions: [...sessions.values()].map(({ agentId, sessionKey }) => ({ agentId, sessionKey })),
    runIds: [...new Set([...params.runIds].map((runId) => runId.trim()).filter(Boolean))],
  };
  const receipt: SessionRunStopReceipt = { stoppedAt, sessions: [...sessions.values()] };
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("run_stopped")) {
    return receipt;
  }
  // The runner calls each handler synchronously; only its asynchronous tail is detached.
  void runner
    .runRunStopped(event, event.sessions.length === 1 ? { ...event.sessions[0] } : {})
    .catch((error: unknown) => {
      log.warn(`run_stopped hook failed: ${formatErrorMessage(error)}`);
    });
  return receipt;
}

type StoppedRow = Readonly<{ storePath?: string; sessionKey?: string; sessionId?: string }>;

/**
 * One stopped row: its store, key and incarnation. A key and incarnation can repeat across stores
 * (a copied row, `global` under several agents), so proof is never shared between rows.
 * @internal Exposed for unit tests only.
 */
export function userStopTargetKey(row: StoppedRow): string | undefined {
  return row.storePath && row.sessionKey && row.sessionId
    ? JSON.stringify([row.storePath, row.sessionKey, row.sessionId])
    : undefined;
}

/** The row an idle Stop's native abort mark was guarded against (`matchesSessionAbortTargetOwner`). */
export type AbortTargetMark = Readonly<{
  row: StoppedRow;
  owner: Parameters<typeof matchesSessionAbortTargetOwner>[1];
}>;

/** Copies the guarded owner before the mark is written: a later change to the row object never widens it. */
export function captureAbortTargetMark(
  row: Omit<StoppedRow, "sessionId">,
  entry: AbortTargetMark["owner"],
): AbortTargetMark {
  const { sessionId, lifecycleRevision, activeWriterRunId } = entry;
  return {
    row: { storePath: row.storePath, sessionKey: row.sessionKey, sessionId },
    owner: { sessionId, lifecycleRevision, activeWriterRunId },
  };
}

/**
 * What proves a Stop ended a row's own run: the run ids it cancelled, per stopped row
 * (`userStopTargetKey`), or for an idle Stop the target its native abort mark matched.
 * @internal Exposed for unit tests only.
 */
export type UserStopProof = Readonly<{
  runIds: ReadonlyMap<string, ReadonlySet<string>>;
  mark?: AbortTargetMark;
}>;

/**
 * Records a user's Stop on each stopped session whose own run it ended, so the next reply prompt
 * says the user stopped it (get-reply-run-context states and retires it). The row's owner is its
 * admitted writer, else its live or last lifecycle run, so a stale lastRunId never outranks a
 * current writer. Only the stopped incarnation's row is written, a newer Stop of it is kept, a
 * missing row is not created, and a failed write never fails the Stop.
 * @internal Exposed for unit tests only.
 */
export async function recordSessionRunStopped(
  receipt: SessionRunStopReceipt | undefined,
  proof: UserStopProof,
): Promise<void> {
  if (!receipt) {
    return;
  }
  for (const { sessionId, ...scope } of receipt.sessions) {
    try {
      const { matchesSessionAbortTargetOwner, updateSessionEntry } =
        await sessionAccessorLoader.load();
      const target = userStopTargetKey({ ...scope, sessionId });
      const cancelled = target ? proof.runIds.get(target) : undefined;
      const mark =
        target && proof.mark && userStopTargetKey(proof.mark.row) === target
          ? proof.mark.owner
          : undefined;
      await updateSessionEntry(scope, (entry) => {
        const owner = entry.activeWriterRunId ?? entry.lifecycleRunId ?? entry.lastRunId;
        // An idle Stop cancels nothing here: its abort mark proves the row only while the row
        // still matches the owner that mark was guarded against.
        const stoppedOwnRun = cancelled?.size
          ? owner !== undefined && cancelled.has(owner)
          : mark !== undefined && matchesSessionAbortTargetOwner(entry, mark);
        return !stoppedOwnRun ||
          entry.sessionId !== sessionId ||
          (resolveUserStoppedAt(entry) ?? 0) >= receipt.stoppedAt
          ? null
          : { userStoppedAt: receipt.stoppedAt, userStoppedSessionId: sessionId };
      });
    } catch (error) {
      log.warn(`user Stop record failed for ${scope.sessionKey}: ${formatErrorMessage(error)}`);
    }
  }
}

/**
 * One Stop's claim to the user-Stop record. Only a user-initiated Stop (the native abort reason
 * flag) records, once, after its cancellation committed. Each operation it stops fences its
 * successor's admission until that record settles, which it always does, so the next turn reads
 * the note and a failed write never leaves the session fenced.
 */
export function trackUserStop(params: {
  reason: unknown;
  receipt?: () => SessionRunStopReceipt | undefined;
}) {
  const tracked = params.receipt !== undefined && isUserInitiatedAgentRunAbortReason(params.reason);
  // Committed run ids per stopped row: one row's cancellation never proves another's.
  const runIds = new Map<string, Set<string>>();
  const settled = createDeferredCore();
  let recording: Promise<void> | undefined;
  const add = (stopped: StoppedRow, ...ids: Array<string | undefined>) => {
    const target = userStopTargetKey(stopped);
    for (const id of ids) {
      if (id && target) {
        runIds.set(target, (runIds.get(target) ?? new Set()).add(id));
      }
    }
  };
  /** Records once; later calls share the first attempt, which settles even when nothing qualifies. */
  const record = (mark?: AbortTargetMark): Promise<void> => {
    recording ??= (
      tracked && (runIds.size > 0 || mark)
        ? recordSessionRunStopped(params.receipt?.(), { runIds, mark })
        : Promise.resolve()
    ).finally(() => settled.resolve());
    return recording;
  };
  return {
    /** Before cancellation: successors of these operations wait for the record. */
    fence(operations: Iterable<ReplyOperation>): void {
      if (!tracked) {
        return;
      }
      for (const operation of new Set(operations)) {
        registerReplyOperationSuccessorBarrier({
          operation,
          sessionId: operation.sessionId,
          sessionKeys: [operation.key],
          deferUntilClear: true,
          start: () => settled.promise,
        });
      }
    },
    /** A committed cancellation of an input or operation (the kernel's own commit callback). */
    cancelled(target: SessionControllerInput | ReplyOperation): void {
      if ("instance" in target) {
        const operation = target.claim?.operation;
        add(
          {
            ...getSessionControllerSourceIdentity(target),
            storePath: ((operation && getOperationSessionTarget(operation)) ?? target.target)
              ?.storeScope,
          },
          target.protocolRunId,
          // An operation keeps every backend run id it attached, even after cancellation detaches it.
          ...(operation ? listOperationBackendRunIds(operation) : []),
        );
      } else {
        add(
          {
            storePath: getOperationSessionTarget(target)?.storeScope,
            sessionKey: target.key,
            sessionId: target.sessionId,
          },
          ...listOperationBackendRunIds(target),
        );
      }
    },
    effectCancelled(effect: SessionControllerStopRunEffect): void {
      const { storeScope, sessionKey } = effect.effect.ref.target;
      add({ storePath: storeScope, sessionKey, sessionId: effect.run.sessionId }, effect.run.runId);
    },
    /**
     * Once the parent phase exits, committed or failed: record the runs it cancelled at once, so
     * the fence releases after one store write, never behind slow child or ACP cancellation. The
     * native abort-target writers patch the current row, so they keep it. With no run id to prove
     * (an idle Stop, a run cancelled before its backend had an id), the fence releases now and the
     * native abort mark records later.
     */
    recordCommitted(): void {
      if (runIds.size > 0) {
        void record();
      } else {
        settled.resolve();
      }
    },
    record,
  };
}
