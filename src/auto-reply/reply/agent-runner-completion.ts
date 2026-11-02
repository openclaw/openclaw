import { randomUUID } from "node:crypto";
import type {
  SessionActorAuthority,
  SessionActorReceipt,
  SessionActorReducer,
} from "../../config/sessions/session-actor-contract.js";
import { reduceSessionActorEntry } from "../../config/sessions/session-actor-reducers.js";
import {
  runSessionActorCommand,
  withSessionActor,
} from "../../config/sessions/session-actor-scope.js";
import { buildSessionTranscriptTurnExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { SessionActivitySummaryCompletion } from "../../gateway/session-activity-summary-completion.js";
import { logVerbose } from "../../globals.js";
import { wrapSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";

/** One retained terminal owner, including no-send and exceptional completion. */
export async function withAgentTurnCompletion<T>(
  params: {
    agentId?: string;
    storePath?: string;
    sessionKey?: string;
    entry?: SessionEntry;
    writer?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">;
    operation: ReplyOperation;
    activitySummaryCompletion?: SessionActivitySummaryCompletion;
    publish(entry: SessionEntry): void;
  },
  consume: (completion: AgentTurnCompletion | undefined) => Promise<T>,
): Promise<T> {
  const { storePath, sessionKey, entry, operation } = params;
  if (!storePath || !sessionKey || !entry) {
    return consume(undefined);
  }
  const writer = params.writer ?? entry;
  const expected = {
    sessionId: writer.sessionId,
    lifecycleRevision: writer.lifecycleRevision,
    writerRunId: writer.activeWriterRunId,
  };
  const operationKey = operation.key;
  const assertCurrent = () => {
    if (operation.key !== operationKey || !isCurrentSessionControllerOperation(operation)) {
      throw new Error("Terminal accounting lost its reply operation");
    }
  };
  assertCurrent();
  const result = await withSessionActor(
    { agentId: params.agentId, storePath, sessionKey },
    { assertCurrent, assertReadable: assertCurrent },
    async (actor) => {
      const authority: SessionActorAuthority = {
        assertCurrent,
        authorize(_stage, facts) {
          const current = facts.entry;
          if (
            !current ||
            current.sessionId !== expected.sessionId ||
            current.lifecycleRevision !== expected.lifecycleRevision ||
            current.activeWriterRunId !== expected.writerRunId
          ) {
            throw new Error("Terminal accounting session changed");
          }
        },
      };
      let snapshot = actor.snapshot(authority) ?? (await actor.read(authority));
      const prepared: Parameters<AgentTurnCompletion["patch"]>[0][] = [];
      let finished = false;
      const project = () => {
        let next = snapshot.entry!;
        const reducers: SessionActorReducer[] = [];
        for (const preparation of prepared) {
          const reducer = typeof preparation === "function" ? preparation(next) : preparation;
          if (reducer) {
            reducers.push(reducer);
            next = reduceSessionActorEntry(next, [reducer]);
          }
        }
        return { entry: next, reducers };
      };
      const refresh = async () => {
        snapshot = actor.snapshot(authority) ?? (await actor.read(authority));
        return project().entry;
      };
      const completion: AgentTurnCompletion = {
        assertCurrent() {
          assertCurrent();
          actor.assertCurrent();
          return actor.snapshot(authority)?.entry;
        },
        current: () => project().entry,
        refresh,
        patch(reducer) {
          if (finished) {
            throw new Error("Terminal accounting is already settled");
          }
          prepared.push(reducer);
        },
        async complete(pendingFinalDelivery) {
          if (finished) {
            if (pendingFinalDelivery) {
              throw new Error("Final delivery custody is already settled");
            }
            return snapshot.entry!;
          }
          finished = true;
          await refresh();
          let { reducers } = project();
          const activitySummary = params.activitySummaryCompletion?.take();
          if (reducers.length === 0 && !pendingFinalDelivery && !activitySummary) {
            return snapshot.entry!;
          }
          const committed: { receipt?: SessionActorReceipt } = {};
          const outcome = await runSessionActorCommand(actor, authority, async (current) => {
            snapshot = current ?? actor.snapshot(authority) ?? (await actor.read(authority));
            ({ reducers } = project());
            return actor.completeTurn(
              {
                commandId: randomUUID(),
                phaseId: `complete:${operationKey}`,
                expected: actor.target.database.kind === "memory" ? undefined : snapshot.version,
                reducers,
                activitySummary,
                bookkeeping: {
                  sessionId: expected.sessionId,
                  lifecycleRevision: expected.lifecycleRevision ?? null,
                  writerRunId: expected.writerRunId,
                  expectedState: buildSessionTranscriptTurnExpectedState(snapshot.entry!),
                },
                pendingFinalDelivery,
              },
              authority,
              {
                committed: (receipt) => {
                  committed.receipt = receipt.receipt;
                  if (activitySummary && receipt.receipt.postimage.entry) {
                    params.activitySummaryCompletion?.committed(receipt.receipt.postimage.entry);
                  }
                },
              },
            );
          });
          if (committed.receipt) {
            snapshot = committed.receipt.postimage;
            params.publish(snapshot.entry!);
          }
          if (
            outcome.kind === "rolled-back" &&
            outcome.reason !== "stale-state" &&
            !pendingFinalDelivery &&
            reducers.every((reducer) => reducer.kind === "usage")
          ) {
            await refresh();
            logVerbose(`failed to persist usage update: ${outcome.error.message}`);
            return snapshot.entry!;
          }
          if (outcome.kind !== "committed") {
            throw wrapSqliteWorkerError(
              outcome.error.message,
              outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
              outcome.error,
            );
          }
          if (outcome.failure) {
            throw new Error(outcome.failure.message);
          }
          return snapshot.entry!;
        },
      };
      let value: T;
      try {
        value = await consume(completion);
      } catch (error) {
        try {
          await completion.complete();
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "Terminal accounting failed to settle",
            { cause: settlementError },
          );
        }
        throw error;
      }
      await completion.complete();
      return { value };
    },
  );
  if (!result) {
    throw new Error("Terminal accounting session is unavailable");
  }
  return result.value;
}
