import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type {
  SessionProviderReview,
  SessionProviderReviewComparison,
} from "./provider-review.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { runSessionEntryWorkerMutation } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
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
  return withSessionStoreTarget(
    { agentId: logical.agentId, storePath, env, candidates },
    (selected, owner) =>
      operation({ ...selected.database, env }, logical.sessionKey, owner.assertCurrent),
    assertCallerCurrent,
  );
}

export async function readSessionProviderReview(
  target: SessionProviderReviewTarget,
  assertCurrent: () => void,
): Promise<SessionEntry | undefined> {
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
      return runSessionEntryWorkerMutation(
        { ...options, path: resolveOpenClawAgentSqlitePath(options) },
        undefined,
        assertHeld,
        async (worker) => {
          const result = await worker.execute({ type: "session.providerReview.compare", input });
          return { kind: "committed", value: result.entry, publication: result.publication };
        },
        { identityAgentId: options.agentId },
        {
          errors: {
            identity: "Provider review has no prepared native database identity",
            unknown: "Provider review has no confirmed native completion and commit receipt",
            missing: "Session disappeared before provider review update",
            publication: "Provider review commit omitted its publication receipt",
          },
        },
      );
    },
  );
}
