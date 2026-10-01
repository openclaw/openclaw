import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { invalidateSessionBranchCache } from "./session-accessor.sqlite-branches.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { SessionMessageForkPublication } from "./session-accessor.sqlite-message-cut-publication.js";
import type { SessionForkAtMessageWorkerInput } from "./session-accessor.sqlite-message-cut.types.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry } from "./types.js";

type ExpectedState = Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">;
type ForkResult = SessionMessageCutMutationResult | { status: "conflict" };

/** Keep the full transcript cut in the canonical agent writer, not the Gateway event loop. */
export async function forkSessionAtMessageInWorker(
  params: SessionMessageCutMutationParams & { targetKey: string },
  expectedState: ExpectedState,
): Promise<ForkResult> {
  const sourceKey = normalizeStoreSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  const assertCurrent = () => params.commitGuard?.();
  assertCurrent();
  await restoreSessionColdTranscript(
    {
      ...params,
      agentId: resolved.agentId,
      sessionId: expectedState.sessionId,
    },
    assertCurrent,
  );
  assertCurrent();
  const databaseOptions = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath(databaseOptions);
  const input: SessionForkAtMessageWorkerInput = {
    canonicalSourceKey: normalizeStoreSessionKey(params.sessionKey),
    sourceKey,
    targetKey: normalizeStoreSessionKey(params.targetKey),
    entryId: params.entryId,
    expectedState,
    ...(params.creation ? { creation: params.creation } : {}),
  };
  let admission:
    | {
        operation: import("../../infra/sqlite-worker-operation-admission.js").SqliteWorkerOperationAdmission;
        retained: import("../../infra/sqlite-worker-operation-settlement.js").RetainedWorkerTransactionAdmission;
      }
    | undefined;
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  return await withSessionEntryWorker(
    { ...databaseOptions, path },
    undefined,
    assertCurrent,
    (execution, source) =>
      execution
        .runExisting(source, async (worker) => {
          const outcome = await worker
            .execute({ type: "session.transcript.forkAtMessage", input })
            .then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          if (admission) {
            await admission.retained.settled;
            const facts = admission.operation.committed?.facts;
            const committed =
              isRecord(facts) &&
              facts.kind === "session-message-forked" &&
              facts.key === input.targetKey &&
              facts.sourceSessionId === expectedState.sessionId &&
              typeof facts.sessionId === "string" &&
              typeof facts.databaseIdentity === "string" &&
              (facts.lifecycleRevision === undefined || typeof facts.lifecycleRevision === "string")
                ? (facts as SessionMessageForkPublication) // SAFETY: The receipt discriminator and consumed fields are validated above.
                : undefined;
            const unknown =
              admission.operation.settlement?.kind !== "completed" ||
              (!outcome.ok && committed !== undefined) ||
              (outcome.ok && outcome.value.status === "created" && (!committed || !publication));
            const published = publication?.settle(committed, unknown);
            if (committed && published) {
              publishCommittedSessionIdentity(
                resolved.agentId,
                committed.databaseIdentity,
                published.previous,
                published.current,
              );
            }
            if (committed) {
              invalidateSessionBranchCache(path, [expectedState.sessionId, committed.sessionId]);
            }
            if (unknown) {
              if (!outcome.ok && hasSqliteWorkerOutcomeUnknown(outcome.error)) {
                throw outcome.error;
              }
              const error = new SqliteWorkerError(
                "Session fork worker has no confirmed native completion and commit receipt",
                "outcome-unknown",
              );
              error.cause = outcome.ok ? undefined : outcome.error;
              throw error;
            }
          } else if (outcome.ok && outcome.value.status === "created") {
            throw new SqliteWorkerError(
              "Session fork worker omitted commit admission",
              "outcome-unknown",
            );
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          return outcome.value;
        })
        .then((value) => {
          if (!value) {
            throw new Error("Session fork database disappeared before worker execution");
          }
          return value;
        }),
    (operation, retained, facts) => {
      admission = { operation, retained };
      const proposed =
        isRecord(facts) &&
        isRecord(facts.publication) &&
        facts.publication.kind === "session-message-forked" &&
        facts.publication.key === input.targetKey &&
        facts.publication.sourceSessionId === expectedState.sessionId &&
        typeof facts.publication.databaseIdentity === "string"
          ? facts.publication
          : undefined;
      if (proposed) {
        publication = retainSessionEntryWorkerPublication({
          agentId: resolved.agentId,
          storePath: path,
          // SAFETY: The proposed publication predicate checked databaseIdentity is a string.
          databaseIdentity: proposed.databaseIdentity as string,
        });
        publication.begin([input.targetKey], []);
      }
    },
  );
}
