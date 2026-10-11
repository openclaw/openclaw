import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentPathWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import {
  captureSessionActorStorageOwner,
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";

/** Reprepare only an explicitly refused version, never an uncertain accepted write. */
export async function runSessionActorCommand<Value>(
  actor: SessionActor,
  authority: SessionActorAuthority,
  command: (snapshot: SessionActorHotState | undefined) => Promise<SessionActorOutcome<Value>>,
): Promise<SessionActorOutcome<Value>> {
  if (actor.target.database.kind === "memory") {
    return command(undefined);
  }
  const run = async () => {
    const outcome = await command(actor.snapshot(authority));
    return outcome.kind === "stale-version" ? command(outcome.postimage) : outcome;
  };
  // Keep the read/command/rebase on one FIFO turn; a queued writer must not
  // invalidate the refused postimage before its single retry can enter.
  return actor.target.database.kind === "file"
    ? runOpenClawAgentPathWriteAdmission(actor.target.database.nativeLocation, run, true)
    : run();
}

/** Retain the captured physical writer, never reselect a target after an accepted command. */
export async function withSessionActor<T>(
  input: SessionEntryReadScope,
  lifetime: SessionActorLifetime,
  consume: (actor: SessionActor) => Promise<T>,
): Promise<T | undefined> {
  lifetime.assertAdmission?.();
  lifetime.assertCurrent();
  const authority = {
    assertCurrent: () => lifetime.assertCurrent(),
    authorize: () => lifetime.assertCurrent(),
  };
  const memory = captureSessionActorStorageOwner(input, authority);
  if (memory) {
    const binding = await acquireSessionActorStorage(input, { lifetime, authority });
    if (!binding) {
      return undefined;
    }
    try {
      return await runWithSessionActorStorage(binding, () => consume(binding.actor));
    } finally {
      await binding.actor.release();
    }
  }
  const scope = await prepareSqliteScope(input);
  lifetime.assertCurrent();
  const options = toDatabaseOptions(scope);
  const database = { ...options, path: resolveOpenClawAgentSqlitePath(options) };
  const identity = readDatabasePathIdentitySync(database.path);
  if (!identity.key.startsWith("file:")) {
    return undefined;
  }
  const target: SessionActorTarget = {
    database: {
      kind: "file",
      physicalIdentity: identity.key.slice("file:".length),
      birthtime: identity.birthtime,
      nativeLocation: identity.canonicalPath,
    },
    sessionKey: scope.sessionKey,
  };
  const actor = await createSessionActorFactory({
    ...database,
    path: identity.canonicalPath,
  }).acquire(target, lifetime);
  try {
    return await consume(actor);
  } finally {
    await actor.release();
  }
}
