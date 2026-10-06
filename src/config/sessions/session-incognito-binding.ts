import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { bindPreparedSessionEntryPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { SessionEntry } from "./types.js";

export type IncognitoSessionBinding = Readonly<{
  actor: IncognitoSessionActor;
  admissionSignal?: AbortSignal;
}>;

const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionBinding"),
  () => new AsyncLocalStorage<IncognitoSessionBinding>(),
);

/** Capture before yielding; a retained binding must never adopt a successor actor. */
export function captureIncognitoSessionBinding(target?: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey?: string;
}): IncognitoSessionBinding | undefined {
  const binding = bindings.getStore();
  const exactPath = Boolean(
    binding && target?.storePath && path.resolve(target.storePath) === binding.actor.path,
  );
  if (
    !binding ||
    (target &&
      !isIncognitoSessionKey(target.sessionKey) &&
      !exactPath &&
      !(
        target.storePath &&
        isIncognitoOpenClawAgentSqlitePath(target.storePath, {
          ...target,
          agentId: target.agentId ?? binding.actor.agentId,
        })
      ))
  ) {
    return undefined;
  }
  binding.actor.assertCurrent();
  if (target) {
    if (
      !target.sessionKey &&
      exactPath &&
      (!target.agentId || target.agentId === binding.actor.agentId)
    ) {
      return binding;
    }
    const options = toDatabaseOptions(
      resolveSqliteScope({ ...target, sessionKey: target.sessionKey ?? "" }),
    );
    if (
      options.agentId !== binding.actor.agentId ||
      resolveOpenClawAgentSqlitePath(options) !== binding.actor.path
    ) {
      throw new Error("Session target belongs to another incognito actor");
    }
  }
  return binding;
}

/** Facts have already been installed under actor FIFO custody before observers run. */
export function publishIncognitoSessionEntry(
  actor: IncognitoSessionActor,
  sessionKey: string,
  previous: SessionEntry | undefined,
  entry: SessionEntry,
): void {
  const change: SessionRowChange = {
    agentId: actor.agentId,
    storePath: actor.path,
    sessionKey,
    factsInvalidated: true,
  };
  bindPreparedSessionEntryPublication(change, {
    kind: "source",
    databaseIdentity: actor.identity.incarnation,
    canonicalPath: actor.path,
  });
  sessionChanges.emit(change);
  publishCommittedSessionIdentity(
    actor.agentId,
    actor.identity.incarnation,
    new Map(previous ? [[sessionKey, previous]] : []),
    new Map([[sessionKey, entry]]),
  );
}

export function withIncognitoSessionBinding<T>(
  binding: IncognitoSessionBinding,
  operation: () => T,
): T {
  return bindings.run(binding, operation);
}

/**
 * Inactive until atomic activation supplies this binding at runtime acquisition.
 * @internal Remove this inactive-entry exemption when runtime acquisition installs the binding.
 */
export function withIncognitoSessionActor<T>(
  actor: IncognitoSessionActor,
  operation: () => Promise<T>,
  admissionSignal?: AbortSignal,
): Promise<T> {
  actor.assertCurrent();
  admissionSignal?.throwIfAborted();
  return actor.sessions.withSharedState(() =>
    withIncognitoSessionBinding({ actor, admissionSignal }, operation),
  );
}
