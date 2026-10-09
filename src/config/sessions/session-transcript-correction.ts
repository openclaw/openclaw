import { AsyncLocalStorage } from "node:async_hooks";
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
  withTranscriptWriteSequence,
} from "./session-accessor.sqlite-transcript-write.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionOperation,
} from "./session-incognito-binding.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
} from "./session-source-authority.js";
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
  const operation = captureIncognitoSessionOperation(scope);
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito && operation) {
    const { actor } = incognito;
    return actor.sessions.withSharedState(async () => {
      const ownerSource = await prepareSessionSourceAuthority(assertOwned);
      const failures: unknown[] = [];
      try {
        if (
          ownerSource.nativeSource ||
          ownerSource.hasOpaqueCheck ||
          ownerSource.checks.some(
            ({ predicate }) =>
              predicate.source.path !== actor.path ||
              predicate.source.agentId !== actor.agentId ||
              predicate.source.databaseIdentity !== actor.identity.incarnation,
          )
        ) {
          throw new Error(
            "Actor transcript correction requires owner authority prepared for the same actor",
          );
        }
        const authority = {
          assertCurrent: () => {
            operation.authority.assertCurrent();
            (ownerSource.assertPreparedCurrent ?? ownerSource.assertCurrent)();
          },
        };
        const input = {
          ...incognito.target,
          fence: scope,
          selectedLifecycleRevision: incognito.target.lifecycleRevision ?? null,
          ownerSources: ownerSource.checks.map(({ predicate }) => predicate),
        };
        const snapshot = await actor.sessions.transcript(
          authority,
          {
            type: "session.correction.prepare",
            input: { ...input, afterSeq },
          },
          operation.admissionSignal,
        );
        if ("refusedOwnerSource" in snapshot) {
          const refused = snapshot.refusedOwnerSource;
          ownerSource.checks[refused.index]?.refuse(refused.facts);
          throw new Error("Transcript correction owner refusal omitted its prepared assertion");
        }
        acceptSessionSourceValidation(ownerSource, snapshot.sourceValidation);
        authority.assertCurrent();
        const events: TranscriptEvent[] = snapshot.rows.map((row) => JSON.parse(row.eventJson));
        const context: TranscriptCorrectionContext = {
          generation: snapshot.version.generation,
          readEvents: async () => events,
          replaceEvents: async (replacement) => {
            authority.assertCurrent();
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
              return [
                { entryId: original.id, expectedEventJson: snapshot.rows[index]!.eventJson, event },
              ];
            });
            const committed = await actor.sessions.transcript(
              authority,
              {
                type: "session.correction.commit",
                input: {
                  ...input,
                  version: snapshot.version,
                  rows,
                  allowLaterAppends: afterSeq !== undefined,
                },
              },
              undefined,
              undefined,
              undefined,
              undefined,
              (_refused, validation) => {
                acceptSessionSourceValidation(ownerSource, validation);
                authority.assertCurrent();
              },
            );
            if ("refusedOwnerSource" in committed) {
              const refused = committed.refusedOwnerSource;
              ownerSource.checks[refused.index]?.refuse(refused.facts);
              throw new Error("Transcript correction owner refusal omitted its prepared assertion");
            }
            context.generation = committed.generation;
          },
        };
        const result = await withTranscriptLockSettlement((enqueue) => {
          const queue = AsyncLocalStorage.bind(enqueue);
          return run({
            get generation() {
              return context.generation;
            },
            readEvents: () =>
              queue(async () => {
                operation.admissionSignal?.throwIfAborted();
                authority.assertCurrent();
                if (ownerSource.checks.length) {
                  const validated = await actor.sessions.transcript(
                    authority,
                    { type: "session.lock.facts", input: { ...input, idempotencyKeys: [] } },
                    operation.admissionSignal,
                  );
                  if ("refusedOwnerSource" in validated) {
                    const refused = validated.refusedOwnerSource;
                    ownerSource.checks[refused.index]?.refuse(refused.facts);
                    throw new Error(
                      "Transcript correction owner refusal omitted its prepared assertion",
                    );
                  }
                  acceptSessionSourceValidation(ownerSource, validated.sourceValidation);
                  authority.assertCurrent();
                }
                return context.readEvents();
              }),
            replaceEvents: async (replacement) => {
              operation.admissionSignal?.throwIfAborted();
              return queue(() => context.replaceEvents(replacement));
            },
          });
        });
        authority.assertCurrent();
        return result;
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        await releaseSessionSourceAuthorities([ownerSource], failures);
      }
    });
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
    undefined,
    targetDiscoveryLane,
  );
}
