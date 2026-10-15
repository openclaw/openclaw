import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { loadTranscriptEventRowsAfterSeqSync } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readSessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark.js";
import {
  rewriteTranscriptEventRowsExact,
  withTranscriptWriteSequence,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import type { SessionTranscriptCorrectionCommitted } from "./session-transcript-mutation.types.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type TranscriptCorrectionContext = {
  readEvents(): Promise<TranscriptEvent[]>;
  replaceEvents(events: readonly TranscriptEvent[]): Promise<void>;
  generation: string | null;
};

function selectCorrectionRows(
  events: readonly TranscriptEvent[],
  replacement: readonly TranscriptEvent[],
  eventJson: readonly string[],
) {
  if (replacement.length !== events.length) {
    throw new Error("Transcript correction cannot add or remove events");
  }
  return replacement.flatMap((event, index) => {
    const original = events[index];
    if (event === original) {
      return [];
    }
    if (!isRecord(original) || typeof original.id !== "string") {
      throw new Error("Transcript correction requires an identified event");
    }
    return [{ entryId: original.id, expectedEventJson: eventJson[index]!, event }];
  });
}

/** Pure display preparation retains its source until exact-row commit and cleanup settle. */
export async function withPreparedTranscriptCorrection<T>(
  requested: SessionTranscriptWriteScope,
  run: (context: TranscriptCorrectionContext) => Promise<T>,
  afterSeq?: number,
): Promise<T> {
  const assertCaller = captureOwnedTranscriptWriteAssertion(requested);
  const callerAuthority = { assertCurrent: assertCaller, authorize: assertCaller };
  if (captureSessionActorStorageOwner(requested, callerAuthority)) {
    const result = await withSessionActorStorage(
      requested,
      {
        authority: callerAuthority,
        lifetime: { assertCurrent: assertCaller, assertReadable: assertCaller },
      },
      async () => ({ value: await runPreparedTranscriptCorrection(requested, run, afterSeq) }),
    );
    if (!result) {
      throw new Error("Session transcript window is unavailable");
    }
    return result.value;
  }
  return runPreparedTranscriptCorrection(requested, run, afterSeq);
}

async function runPreparedTranscriptCorrection<T>(
  requested: SessionTranscriptWriteScope,
  run: (context: TranscriptCorrectionContext) => Promise<T>,
  afterSeq?: number,
): Promise<T> {
  const fenced = withOwnedSessionTranscriptWriterFence(requested);
  const memory = getSessionActorStorageBinding(fenced);
  const selectedSessionId =
    fenced.sessionId ?? memory?.actor.snapshot(memory.authority)?.entry?.sessionId;
  if (memory && !selectedSessionId) {
    throw new Error("Transcript correction requires its selected session window");
  }
  const target = memory
    ? {
        agentId: memory.agentId,
        path: memory.path,
        sessionKey: memory.actor.target.sessionKey,
        sessionId: selectedSessionId!,
        env: fenced.env,
      }
    : resolveSqliteTranscriptScope(fenced);
  const scope = { ...fenced, sessionId: target.sessionId };
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  if (memory) {
    const authority = {
      ...memory.authority,
      assertCurrent() {
        memory.authority.assertCurrent();
        memory.actor.assertReadable();
        assertOwned();
      },
    };
    const snapshot = await memory.actor.storage!.read(
      { type: "session.correction.prepare", input: { scope, afterSeq } },
      authority,
    );
    const eventJson = snapshot.rows.map((row) => row.eventJson);
    const events: TranscriptEvent[] = eventJson.map((json) => JSON.parse(json));
    let generation = snapshot.version.generation;
    const value = await withTranscriptLockSettlement((enqueue) => {
      const queue = AsyncLocalStorage.bind(enqueue);
      return run({
        get generation() {
          return generation;
        },
        readEvents: () =>
          queue(async () => {
            authority.assertCurrent();
            return events;
          }),
        replaceEvents: (replacement) =>
          queue(async () => {
            const outcome = await memory.actor.storage!.mutate(
              {
                type: "session.correction.commit",
                input: {
                  scope,
                  version: snapshot.version,
                  rows: selectCorrectionRows(events, replacement, eventJson),
                  allowLaterAppends: afterSeq !== undefined,
                },
              },
              authority,
            );
            generation = readSessionActorStorageResult(outcome).generation;
          }),
      });
    });
    authority.assertCurrent();
    return value;
  }
  const runNative = async (native: typeof scope) => {
    if (afterSeq !== undefined) {
      const rows = loadTranscriptEventRowsAfterSeqSync(native, afterSeq);
      const context: TranscriptCorrectionContext = {
        generation: readSessionTranscriptWatermark(native).generation,
        readEvents: async () => rows.map((row) => row.event),
        replaceEvents: async (events) => {
          const rewritten = await rewriteTranscriptEventRowsExact(native, {
            expectedGeneration: context.generation,
            rows: events.flatMap((event, index) =>
              event === rows[index]?.event
                ? []
                : [
                    {
                      event,
                      expectedEventJson: JSON.stringify(rows[index]!.event),
                      seq: rows[index]!.seq,
                    },
                  ],
            ),
          });
          context.generation = rewritten?.generation ?? null;
        },
      };
      return run(context);
    }
    return withTranscriptWriteSequence({ ...scope, ...native }, (locked) =>
      run({
        ...locked,
        generation: readSessionTranscriptWatermark(native).generation,
      }),
    );
  };
  if (!isMainThread) {
    return runNative(scope);
  }
  return withSessionTranscriptReadSource(
    scope,
    async (source) => {
      const assertCurrent = () => {
        source.assertCurrent();
        assertOwned();
      };
      const database = { ...toDatabaseOptions(source.resolved), path: source.scope.storePath };
      const resolved = {
        ...source.resolved,
        sessionKey: source.resolved.sessionKey ?? target.sessionKey,
      };
      if (!source.expectedIdentity) {
        return run({
          generation: null,
          readEvents: async () => [],
          replaceEvents: async () => {
            throw new Error("Cannot correct a missing transcript");
          },
        });
      }
      const result = await runSessionEntryWorkerOperation<
        SessionTranscriptCorrectionCommitted,
        { value: T } | { generation: string | null }
      >({
        database,
        agentId: resolved.agentId,
        assertCurrent,
        candidateKind: "session-transcript-correction",
        prepareWorker: () => ({
          async prepare() {
            const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
            await restoreSessionColdTranscript(source.scope, assertCurrent);
          },
          beforeWrite: assertCurrent,
          async release() {},
        }),
        async run(worker, commit) {
          const hydration = await source.owner.readTranscript({
            target: source.scope,
            resolvedScope: resolved,
            expectedIdentity: source.expectedIdentity,
            afterSeq,
            includeEventJson: true,
          });
          assertCurrent();
          if (hydration.kind !== "full" || !hydration.snapshot.eventJson) {
            throw new Error("Transcript correction requires its complete source bytes");
          }
          const { events, eventJson, version } = hydration.snapshot;
          const context: TranscriptCorrectionContext = {
            generation: version.generation,
            readEvents: async () => events,
            replaceEvents: async (replacement) => {
              assertCurrent();
              const rows = selectCorrectionRows(events, replacement, eventJson);
              const committed = await commit(() =>
                executeSessionMessageRewriteOperation(worker, database.agentId, {
                  type: "session.transcript.correct",
                  input: {
                    scope: resolved,
                    fence: scope,
                    version,
                    rows,
                    allowLaterAppends: afterSeq !== undefined,
                  },
                }),
              );
              if (!("generation" in committed)) {
                throw new Error("Transcript correction omitted its committed generation");
              }
              context.generation = committed.generation;
            },
          };
          const value = await run(context);
          assertCurrent();
          return { value };
        },
        onCommitted: ({ generation }) => ({ generation }),
      });
      if (!("value" in result)) {
        throw new Error("Transcript correction omitted its selected result");
      }
      return result.value;
    },
    undefined,
    targetDiscoveryLane,
  );
}
