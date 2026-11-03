// Continuation (karmaterminal): recipient-authority currency without caller-thread SQL. The epoch
// is read in the session sharing worker under the agent writer FIFO, and the caller's decision
// runs synchronously before that admission releases. Queued writers cannot commit between the
// read and the decision; a native writer that bypasses the FIFO trips the mutation witness and
// the read repeats. Revocation cycles cannot hide: every epoch advance writes a fresh random
// epoch, so restoring the sharing facts never restores a captured authority.
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import { captureSessionEntryNativeMutationWitness } from "./session-entry-read-ordered.js";
import {
  sessionRecipientAuthorityMatches,
  type SessionRecipientAuthority,
  type SessionRecipientAuthorityRecordState,
} from "./session-recipient-authority-types.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";

export type SessionRecipientAuthorityCheck = {
  scope: SessionAccessScope;
  authority: SessionRecipientAuthority;
};

/**
 * A session's recipient-authority row as the writer admission read it. `unowned`: an incognito
 * actor's session, whose authority no durable row records. A database that does not exist holds no
 * row (`missing`).
 */
export type AdmittedSessionRecipientAuthority =
  | SessionRecipientAuthorityRecordState
  | { state: "unowned" };

/** A native writer racing every attempt is a live conflict; the caller then fails closed. */
const ORDERED_READ_ATTEMPTS = 3;

type PreparedCheck = {
  index: number;
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  options: ReturnType<typeof toDatabaseOptions> & { env: NodeJS.ProcessEnv; path: string };
  commandScope: SessionAccessScope;
};

async function prepareCheck(
  scope: SessionAccessScope,
  index: number,
): Promise<PreparedCheck | undefined> {
  // An incognito actor's session has no durable authority row; it is never current.
  if (captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} })) {
    return undefined;
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = await prepareSqliteScope({ ...scope, env });
  const resolvedOptions = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath({ ...resolvedOptions, env });
  return {
    index,
    // The witness looks up the physical database, which a shared store keys by its owner.
    database: { agentId: resolvedOptions.agentId, path, env },
    options: { ...resolvedOptions, env, path },
    commandScope: {
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
      storePath: path,
      env: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
    },
  };
}

async function readUnderAdmission<T>(
  prepared: readonly PreparedCheck[],
  records: AdmittedSessionRecipientAuthority[],
  decide: (records: readonly AdmittedSessionRecipientAuthority[]) => T,
): Promise<T> {
  const byPath = new Map<string, PreparedCheck[]>();
  for (const check of prepared) {
    byPath.set(check.database.path, [...(byPath.get(check.database.path) ?? []), check]);
  }
  const groups = [...byPath.values()];
  return await runOpenClawAgentWriteAdmissions(
    groups.map(([first]) => first!.options),
    async () => {
      const assertNativeCurrent = captureSessionEntryNativeMutationWitness(
        groups.map(([first]) => first!.database),
      );
      for (const group of groups) {
        const execution = captureOpenClawAgentDatabaseExecution(group[0]!.options);
        try {
          const worker = await openOpenClawAgentSqliteWorkerStore<SessionSharingWorkerOperations>(
            group[0]!.options,
            { execution },
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionSharingStore),
              input: undefined,
            },
          );
          try {
            for (const check of group) {
              const read = await worker.executeExisting(
                { type: "authority.read", input: { scope: check.commandScope } },
                () => execution.assertCurrent(),
              );
              records[check.index] = read?.value ?? { state: "missing" };
            }
          } finally {
            await worker.close();
          }
        } finally {
          await execution.release();
        }
      }
      assertNativeCurrent();
      const value = decide(records);
      if (isPromiseLike(value)) {
        void Promise.resolve(value).catch(() => {});
        throw new Error("Recipient authority decisions must remain synchronous");
      }
      return value;
    },
  );
}

/**
 * Decides with each scope's recipient-authority row. `decide` runs synchronously under the writer
 * admission of every involved agent database, so an effect it performs (adopting, enqueueing,
 * settling a verdict) cannot be overtaken by a revocation that commits after the read. A decision
 * that needs the verdict after another await must call this again.
 */
export async function withSessionRecipientAuthorityRecords<T>(
  scopes: readonly SessionAccessScope[],
  decide: (records: readonly AdmittedSessionRecipientAuthority[]) => T,
): Promise<T> {
  if (scopes.length === 0) {
    return decide([]);
  }
  for (let attempt = 1; ; attempt += 1) {
    const records: AdmittedSessionRecipientAuthority[] = scopes.map(() => ({ state: "unowned" }));
    const prepared = (await Promise.all(scopes.map(prepareCheck))).filter(
      (check): check is PreparedCheck => check !== undefined,
    );
    try {
      return prepared.length === 0
        ? decide(records)
        : await readUnderAdmission(prepared, records, decide);
    } catch (error) {
      if (
        !(error instanceof SessionEntryChangedDuringReadError) ||
        attempt >= ORDERED_READ_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

/** Decides with whether each check's captured epoch is still the session's current one. */
export async function withCurrentSessionRecipientAuthority<T>(
  checks: readonly SessionRecipientAuthorityCheck[],
  decide: (current: readonly boolean[]) => T,
): Promise<T> {
  return await withSessionRecipientAuthorityRecords(
    checks.map((check) => check.scope),
    (records) =>
      decide(
        records.map(
          (record, index) =>
            record.state !== "unowned" &&
            sessionRecipientAuthorityMatches(checks[index]!.authority, record),
        ),
      ),
  );
}

/** One check, for callers whose effect is fenced again downstream (prompt adoption). */
export async function isSessionRecipientAuthorityCurrentInWorker(
  scope: SessionAccessScope,
  authority: SessionRecipientAuthority,
): Promise<boolean> {
  return await withCurrentSessionRecipientAuthority([{ scope, authority }], ([current]) =>
    Boolean(current),
  );
}
