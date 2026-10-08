import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type {
  SessionProviderReview,
  SessionProviderReviewComparison,
} from "./provider-review.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionEntry } from "./types.js";

export type SessionProviderReviewTarget = SessionAccessScope & {
  sessionId: string;
  lifecycleRevision?: string;
};

async function withProviderReviewDatabase<T>(
  target: SessionProviderReviewTarget,
  assertCallerCurrent: () => void,
  operation: (
    options: OpenClawAgentDatabaseOptions,
    sessionKey: string,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  assertCallerCurrent();
  const env = cloneEnvWithPlatformSemantics(target.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  // Normalize the logical key without consulting a custom store's native registry.
  const logical = resolveSqliteScope({ ...target, storePath: undefined, env });
  const storePath =
    logical.path ?? target.storePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const request = { agentId: logical.agentId, storePath, env };
    let selected = await discovery.readStoreTarget({
      ...request,
      registeredDatabases: { status: "deferred" },
    });
    let assertRegistryCurrent: (() => void) | undefined;
    if (selected.kind === "session-target-registry-required") {
      const registry = await registryRead.read();
      assertRegistryCurrent = registry.assertCurrent;
      registry.assertCurrent();
      discovery.assertCurrent();
      assertCallerCurrent();
      selected = await discovery.readStoreTarget({
        ...request,
        registeredDatabases:
          registry.result.status === "available"
            ? registry.result.entries
            : { status: "unavailable" },
      });
    }
    if (selected.kind !== "session-store-target") {
      throw new Error("Provider review store could not resolve its database owner");
    }
    // Registry facts choose the physical owner. Its canonical execution then owns
    // admission; promoting that writer deliberately invalidates the registry memo.
    assertRegistryCurrent?.();
    const sourcePath = selected.sourcePath;
    const assertCurrent = () => {
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(sourcePath, candidates);
      assertCallerCurrent();
    };
    assertCurrent();
    return operation({ ...selected.database, env }, logical.sessionKey, assertCurrent);
  });
}

export async function readSessionProviderReview(
  target: SessionProviderReviewTarget,
  assertCurrent: () => void,
): Promise<SessionEntry | undefined> {
  assertCurrent();
  const { sessionId, lifecycleRevision } = target;
  return withProviderReviewDatabase(
    target,
    assertCurrent,
    async (options, sessionKey, assertHeld) => {
      const result = await withSessionHistoryWorkerDatabase(options, (owner) =>
        owner.readExactEntries({
          sessionKeys: [sessionKey],
          snapshotFields: [],
          env: options.env ?? {},
        }),
      );
      assertHeld();
      const entry = result.entries.find((row) => row.sessionKey === sessionKey)?.entry;
      return entry?.sessionId === sessionId && entry.lifecycleRevision === lifecycleRevision
        ? entry
        : undefined;
    },
  );
}

/** A review clear can consume only the exact refusal the human acknowledged. */
export async function compareSessionProviderReview(
  target: SessionProviderReviewTarget,
  params: {
    expectedReview: Readonly<SessionProviderReview> | undefined;
    nextReview: SessionProviderReview | undefined;
    assertCurrent: () => void;
  },
): Promise<SessionEntry> {
  params.assertCurrent();
  const capturedTarget = { ...target };
  const input: SessionProviderReviewComparison = structuredClone({
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleRevision: target.lifecycleRevision,
    expectedReview: params.expectedReview,
    nextReview: params.nextReview,
  });
  return withProviderReviewDatabase(
    capturedTarget,
    params.assertCurrent,
    async (options, sessionKey, assertHeld) => {
      input.sessionKey = sessionKey;
      let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
      let admitted:
        | {
            admission: SqliteWorkerOperationAdmission;
            retained: RetainedWorkerTransactionAdmission;
          }
        | undefined;
      return withSessionEntryWorker(
        { ...options, path: resolveOpenClawAgentSqlitePath(options) },
        undefined,
        assertHeld,
        async (execution, source) => {
          const result = await execution.runExisting(source, async (worker) => {
            const databaseIdentity = execution.fileIdentity?.physicalIdentity;
            if (!databaseIdentity) {
              throw new Error("Provider review has no prepared native database identity");
            }
            publication = retainSessionEntryWorkerPublication({
              agentId: execution.agentId,
              storePath: execution.path,
              databaseIdentity,
            });
            const outcome = await worker
              .execute({ type: "session.providerReview.compare", input })
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            let unknown = outcome.ok;
            if (admitted) {
              // Retain the writer until the native commit receipt and host publication settle.
              await admitted.retained.settled;
              const facts = admitted.admission.committed?.facts;
              let receipt = outcome.ok ? outcome.value.publication : undefined;
              if (isRecord(facts) && facts.kind === "session-entry-replacements") {
                // SAFETY: The paired review kernel owns this retained command's receipt.
                receipt = facts as SessionEntryReplacementPublication;
              }
              unknown = admitted.admission.settlement?.kind !== "completed" || !receipt;
              publication.settle(receipt, unknown);
            }
            if (unknown) {
              const error = new SqliteWorkerError(
                "Provider review has no confirmed native completion and commit receipt",
                "outcome-unknown",
              );
              error.cause = outcome.ok ? undefined : outcome.error;
              throw error;
            }
            if (!outcome.ok) {
              throw outcome.error;
            }
            return outcome.value.entry;
          });
          if (!result) {
            throw new Error("Session disappeared before provider review update");
          }
          return result;
        },
        (admission, retained, facts) => {
          if (
            !isRecord(facts) ||
            !isRecord(facts.publication) ||
            facts.publication.kind !== "session-entry-replacements" ||
            !publication
          ) {
            throw new Error("Provider review commit omitted its publication receipt");
          }
          admitted = { admission, retained };
          publication.begin([sessionKey], []);
        },
      );
    },
  );
}
