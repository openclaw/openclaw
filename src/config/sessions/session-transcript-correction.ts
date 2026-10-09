import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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
  withTranscriptWriteLock,
} from "./session-accessor.sqlite-transcript-write.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { SessionTranscriptCorrectionCommitted } from "./session-message-rewrite.worker.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type TranscriptCorrectionContext = {
  readEvents(): Promise<TranscriptEvent[]>;
  replaceEvents(events: readonly TranscriptEvent[]): Promise<void>;
  generation: string | null;
};

/** Pure display preparation retains its source until exact-row commit and cleanup settle. */
export async function withPreparedTranscriptCorrection<T>(
  requested: SessionTranscriptWriteScope,
  run: (context: TranscriptCorrectionContext) => Promise<T>,
  afterSeq?: number,
): Promise<T> {
  const fenced = withOwnedSessionTranscriptWriterFence(requested);
  const target = resolveSqliteTranscriptScope(fenced);
  const scope = { ...fenced, sessionId: target.sessionId };
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
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
    return withTranscriptWriteLock({ ...scope, ...native }, (locked) =>
      run({
        ...locked,
        generation: readSessionTranscriptWatermark(native).generation,
      }),
    );
  };
  if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(target))) {
    return runNative(scope);
  }
  return withSessionTranscriptReadSource(
    scope,
    (native) => runNative({ ...scope, ...native }),
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
              if (replacement.length !== events.length) {
                throw new Error("Transcript correction cannot add or remove events");
              }
              const rows = replacement.flatMap((event, index) => {
                if (event === events[index]) {
                  return [];
                }
                const original = events[index];
                if (!isRecord(original) || typeof original.id !== "string") {
                  throw new Error("Transcript correction requires an identified event");
                }
                return [{ entryId: original.id, expectedEventJson: eventJson[index]!, event }];
              });
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
  );
}
