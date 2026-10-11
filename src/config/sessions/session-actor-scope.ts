import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";

/** Reprepare only an explicitly refused version, never an uncertain accepted write. */
export async function runSessionActorCommand<Value>(
  actor: SessionActor,
  authority: SessionActorAuthority,
  command: (snapshot: SessionActorHotState | undefined) => Promise<SessionActorOutcome<Value>>,
): Promise<SessionActorOutcome<Value>> {
  const outcome = await command(actor.snapshot(authority));
  return outcome.kind === "stale-version" ? command(outcome.postimage) : outcome;
}

/** Retain the captured physical writer, never reselect a target after an accepted command. */
export async function withSessionActor<T>(
  input: SessionEntryReadScope,
  lifetime: SessionActorLifetime,
  consume: (actor: SessionActor) => Promise<T>,
): Promise<T | undefined> {
  lifetime.assertAdmission?.();
  lifetime.assertCurrent();
  const source = captureIncognitoSessionSource(input);
  if (source && "kind" in source) {
    return undefined;
  }
  if (source) {
    const execution = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: source.actor.agentId,
      env: { OPENCLAW_STATE_DIR: path.resolve(source.actor.path, "../../../..") },
      authority: {
        assertCurrent() {
          lifetime.assertCurrent();
          source.actor.assertCurrent();
        },
      },
      existingOnly: true,
      signal: source.admissionSignal,
    });
    if (!execution) {
      return undefined;
    }
    try {
      if (!isDeepStrictEqual(execution.identity, source.actor.identity)) {
        throw new Error("Session actor acquisition changed its incognito owner");
      }
      const actor = await execution.sessionActors.acquire(
        { database: source.actor.identity, sessionKey: input.sessionKey },
        {
          ...lifetime,
          assertAdmission() {
            lifetime.assertAdmission?.();
            source.admissionSignal?.throwIfAborted();
          },
        },
      );
      try {
        return await consume(actor);
      } finally {
        await actor.release();
      }
    } finally {
      await execution.release();
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
  if ("kind" in actor) {
    return undefined;
  }
  try {
    return await consume(actor);
  } finally {
    await actor.release();
  }
}
