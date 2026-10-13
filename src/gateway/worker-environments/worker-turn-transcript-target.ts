import { AsyncLocalStorage } from "node:async_hooks";
import nodePath from "node:path";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import {
  retainPreparedSessionEntryPredicate,
  retainPreparedSessionSharingFacts,
} from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import {
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { retainSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseRuntime } from "../../state/openclaw-agent-db.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";

type WorkerTranscriptSourceIdentity = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "archivedAt"
>;

type WorkerTranscriptTurn = Pick<
  SessionPlacementTurnParams,
  "agentId" | "sessionId" | "sessionKey" | "sessionTarget"
>;

type PreparedWorkerTranscript = {
  target: BoundAgentRunSessionTarget;
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  env: NodeJS.ProcessEnv;
  readCurrent: (target: BoundAgentRunSessionTarget) => WorkerTranscriptSourceIdentity | undefined;
  assertCurrent: () => void;
  release: () => void | Promise<void>;
};

const preparedWorkerTranscript = new AsyncLocalStorage<PreparedWorkerTranscript>();

/** Keep receipt-published facts alive from the worker read through the final effect. */
async function prepareWorkerTranscript(
  target: BoundAgentRunSessionTarget,
  assertPreparing: () => void,
): Promise<PreparedWorkerTranscript> {
  let facts: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
  let predicate: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let settlementPredicate: typeof predicate;
  let source: PreparedWorkerTranscript["source"] | undefined;
  let prepared: PreparedWorkerTranscript | undefined;
  try {
    return await withSessionEntryReadOnlyInWorker(
      target,
      assertPreparing,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (!source || !facts || !owner.scope) {
          throw new Error("Cloud worker transcript has no durable source");
        }
        const snapshot = facts.initialize({
          entry: read.value && projectSessionSharingEntry(read.value),
          membership: new Set(),
        });
        // Transfer the acquired identity before releasing its receipt subscription.
        const databaseIdentity = `file:${source.databaseIdentity}`;
        const retainPredicate = (writerBound: boolean) =>
          retainPreparedSessionEntryPredicate({
            databaseIdentity,
            sessionKey: target.sessionKey,
            entry: snapshot.entry,
            matches: (before, after) =>
              before?.sessionId === after?.sessionId &&
              before?.lifecycleRevision === after?.lifecycleRevision &&
              (!writerBound || before?.activeWriterRunId === after?.activeWriterRunId) &&
              before?.archivedAt === after?.archivedAt,
          });
        predicate = retainPredicate(target.expectedWriterRunId !== undefined);
        // Completed results retain the session while their caller releases its writer.
        settlementPredicate =
          target.expectedWriterRunId === undefined ? predicate : retainPredicate(false);
        facts.release();
        const currentFacts = predicate;
        const settlementFacts = settlementPredicate;
        const env = owner.scope.env ?? process.env;
        const retained = retainSessionHistoryWorkerDatabase({
          agentId: source.agentId,
          path: source.path,
          env,
        });
        let active = true;
        prepared = {
          target: { ...target, storePath: source.path },
          source,
          env,
          readCurrent: (requested) =>
            (requested.expectedWriterRunId === undefined
              ? settlementFacts
              : currentFacts
            ).readCurrent()?.entry,
          assertCurrent: () => {
            if (!active) {
              throw new Error("Cloud worker transcript authority has been released");
            }
            retained.owner.assertCurrent();
          },
          release: () => {
            active = false;
            currentFacts.release();
            settlementFacts.release();
            return retained.release();
          },
        };
        return prepared;
      },
      (database, identity) => {
        if (!identity.key.startsWith("file:")) {
          throw new Error("Cloud worker transcript has no durable source");
        }
        source = {
          agentId: database.agentId,
          path: database.path,
          databaseIdentity: identity.key.slice("file:".length),
          databaseBirthtime: identity.birthtime,
        };
        facts = retainPreparedSessionSharingFacts({
          databaseIdentity: identity.key,
          sessionKey: target.sessionKey,
          acquiring: true,
        });
      },
    );
  } catch (error) {
    if (prepared) {
      await releaseSessionSourceAuthorities([prepared], [error]);
    } else {
      facts?.release();
      predicate?.release();
      settlementPredicate?.release();
    }
    throw error;
  }
}

function findPreparedTranscript(target: BoundAgentRunSessionTarget) {
  const prepared = preparedWorkerTranscript.getStore();
  if (
    !prepared ||
    prepared.target.agentId !== target.agentId ||
    prepared.target.sessionKey !== target.sessionKey ||
    nodePath.resolve(prepared.target.storePath) !== nodePath.resolve(target.storePath)
  ) {
    return undefined;
  }
  return prepared;
}

function currentPreparedTranscript(
  target: BoundAgentRunSessionTarget,
  prepared = findPreparedTranscript(target),
) {
  if (!prepared) {
    throw new Error("Cloud worker transcript requires prepared authority");
  }
  prepared.assertCurrent();
  return prepared;
}

function captureWorkerTurnTranscriptTarget(turn: WorkerTranscriptTurn): BoundAgentRunSessionTarget {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const targetKeyAgentId = parseAgentSessionKey(turn.sessionTarget.sessionKey)?.agentId;
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey) ||
    (targetKeyAgentId && targetKeyAgentId !== turn.sessionTarget.agentId)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
    expectedLifecycleRevision: turn.sessionTarget.expectedLifecycleRevision,
    expectedWriterRunId: turn.sessionTarget.expectedWriterRunId,
  };
}

export function resolveWorkerTurnTranscriptTarget(
  turn: WorkerTranscriptTurn,
): BoundAgentRunSessionTarget {
  const target = captureWorkerTurnTranscriptTarget(turn);
  const memory = captureSessionActorStorageOwner(target, { assertCurrent() {}, authorize() {} });
  const currentEntry = memory
    ? readCapturedSessionActorEntry(memory, target.sessionKey)
    : currentPreparedTranscript(target).readCurrent(target);
  const mismatchedFields = [
    currentEntry?.sessionId !== target.sessionId ? "sessionId" : undefined,
    target.expectedLifecycleRevision !== undefined &&
    currentEntry?.lifecycleRevision !== target.expectedLifecycleRevision
      ? "lifecycleRevision"
      : undefined,
    target.expectedWriterRunId !== undefined &&
    currentEntry?.activeWriterRunId !== target.expectedWriterRunId
      ? "activeWriterRunId"
      : undefined,
  ].filter((field) => field !== undefined);
  if (!currentEntry || mismatchedFields.length > 0) {
    throw new Error(
      `Cloud worker transcript identity is no longer current (target resolution: ${
        currentEntry ? `mismatched ${mismatchedFields.join(", ")}` : "missing projection"
      })`,
    );
  }
  return target;
}

/** Keep the chosen session backend through worker turn settlement. */
export async function withWorkerTurnTranscriptDatabase<T>(
  turn: WorkerTranscriptTurn,
  controls: {
    assertCurrent(): void;
    prepareAuthority(): Promise<Pick<PlacementTurnClaimAuthority, "isCurrent" | "release">>;
    signal?: AbortSignal;
  },
  run: (target: BoundAgentRunSessionTarget) => Promise<T>,
): Promise<T> {
  const captured = captureWorkerTurnTranscriptTarget(turn);
  const target = { ...captured, storePath: nodePath.resolve(captured.storePath) };
  let executing = false;
  let authority: Awaited<ReturnType<typeof controls.prepareAuthority>> | undefined;
  const assertPreparing = () => {
    // Execution owns subsequent liveness and can settle after releasing its placement claim.
    if (executing) {
      return;
    }
    controls.signal?.throwIfAborted();
    if (authority && !authority.isCurrent()) {
      throw new Error("Cloud worker placement authority changed during preparation");
    }
  };
  const memory = captureSessionActorStorageOwner(target, {
    assertCurrent: assertPreparing,
    authorize: assertPreparing,
  });
  const runAdmitted = async (pinned: BoundAgentRunSessionTarget) => {
    controls.assertCurrent();
    const current = resolveWorkerTurnTranscriptTarget({ ...pinned, sessionTarget: pinned });
    executing = true;
    const originalSessionTarget = turn.sessionTarget;
    turn.sessionTarget = current;
    try {
      return await run(current);
    } finally {
      turn.sessionTarget = originalSessionTarget;
    }
  };
  controls.assertCurrent();
  if (memory) {
    const acquired = await acquireSessionActorStorage(target, {
      authority: memory.authority,
      lifetime: { assertCurrent: assertPreparing, assertReadable: assertPreparing },
    });
    if (!acquired) {
      throw new Error("Cloud worker transcript identity is no longer current");
    }
    try {
      authority = await controls.prepareAuthority();
      assertPreparing();
      return await runWithSessionActorStorage(acquired, () => runAdmitted(target));
    } finally {
      authority?.release();
      authority = undefined;
      await acquired.actor.release();
    }
  }
  const prepared = await prepareWorkerTranscript(target, assertPreparing);
  try {
    authority = await controls.prepareAuthority();
    try {
      controls.assertCurrent();
      const assertAdmission = () => {
        prepared.assertCurrent();
        assertPreparing();
      };
      return await withOpenClawAgentDatabaseRuntime(
        { agentId: prepared.source.agentId, path: prepared.source.path, env: prepared.env },
        () => {
          assertAdmission();
          return preparedWorkerTranscript.run(prepared, () => runAdmitted(prepared.target));
        },
        assertAdmission,
        controls.signal,
      );
    } finally {
      authority.release();
      authority = undefined;
    }
  } finally {
    await prepared.release();
  }
}

/** Reuse the accepted turn identity as a transaction-local source predicate. */
export function captureWorkerTurnTranscriptSource(
  target: BoundAgentRunSessionTarget,
  predicate?: {
    fields: (keyof WorkerTranscriptSourceIdentity)[];
    expected: WorkerTranscriptSourceIdentity;
    refuse: () => never;
  },
): SessionSourceAssertion {
  const memory = captureSessionActorStorageOwner(target, { assertCurrent() {}, authorize() {} });
  const expected: WorkerTranscriptSourceIdentity = predicate
    ? { ...predicate.expected }
    : {
        sessionId: target.sessionId,
        ...(target.expectedLifecycleRevision !== undefined
          ? { lifecycleRevision: target.expectedLifecycleRevision }
          : {}),
        ...(target.expectedWriterRunId !== undefined
          ? { activeWriterRunId: target.expectedWriterRunId }
          : {}),
      };
  const fields: (keyof WorkerTranscriptSourceIdentity)[] = predicate
    ? [...predicate.fields]
    : (["sessionId", "lifecycleRevision", "activeWriterRunId"] as const).filter((field) =>
        Object.hasOwn(expected, field),
      );
  const refuse: (facts?: { entry?: WorkerTranscriptSourceIdentity }) => never =
    predicate?.refuse ??
    ((facts): never => {
      throw new Error(
        `Cloud worker transcript identity is no longer current (source callback: ${
          facts === undefined
            ? "worker predicate rejected"
            : facts.entry
              ? `mismatched ${fields.filter((field) => facts.entry?.[field] !== expected[field]).join(", ")}`
              : "missing projection"
        })`,
      );
    });
  const assertEntry = (entry: WorkerTranscriptSourceIdentity | undefined) => {
    if (!entry || fields.some((field) => entry[field] !== expected[field])) {
      refuse({ entry });
    }
  };
  if (memory) {
    return () => assertEntry(readCapturedSessionActorEntry(memory, target.sessionKey));
  }
  // RPC callbacks run in the connection context, outside the launching turn scope.
  const captured = findPreparedTranscript(target);
  const assertCurrent = () =>
    assertEntry(currentPreparedTranscript(target, captured).readCurrent(target));
  return Object.assign(assertCurrent, {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      const current = captured ?? findPreparedTranscript(target);
      const prepared = current ?? (await prepareWorkerTranscript(target, () => {}));
      try {
        prepared.assertCurrent();
        return {
          assertCurrent: prepared.assertCurrent,
          checks: [
            {
              predicate: {
                source: prepared.source,
                sessionKey: target.sessionKey,
                fields,
                expected,
              },
              refuse,
            },
          ],
          release: current ? undefined : prepared.release,
        };
      } catch (error) {
        if (!current) {
          await releaseSessionSourceAuthorities([prepared], [error]);
        }
        throw error;
      }
    },
  });
}

/** Callers retaining a source outside a turn must own its prepared lifetime. */
export async function prepareWorkerTurnTranscriptSource(
  ...args: Parameters<typeof captureWorkerTurnTranscriptSource>
) {
  const source = captureWorkerTurnTranscriptSource(...args);
  const prepared =
    source.prepareSessionSource && !findPreparedTranscript(args[0])
      ? await prepareWorkerTranscript(args[0], () => {})
      : undefined;
  try {
    const captured = prepared
      ? preparedWorkerTranscript.run(prepared, () =>
          captureWorkerTurnTranscriptSource(prepared.target, args[1]),
        )
      : source;
    if (source.prepareSessionSource) {
      captured();
    }
    let active = true;
    const retained = composeSessionSourceAssertion([captured], (assertSource) => {
      if (!active) {
        throw new Error("Cloud worker transcript authority has been released");
      }
      assertSource();
    });
    const release = async () => {
      if (active) {
        active = false;
        await prepared?.release();
      }
    };
    return Object.assign(retained, { release, [Symbol.asyncDispose]: release });
  } catch (error) {
    await releaseSessionSourceAuthorities(prepared ? [prepared] : [], [error]);
    throw error;
  }
}
