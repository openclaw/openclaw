import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
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
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoSessionHistoryBinding } from "./session-incognito-history-read.js";
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
      exactPath &&
      (!target.agentId || target.agentId === binding.actor.agentId) &&
      (!target.sessionKey ||
        (target.env === undefined &&
          isIncognitoSessionKey(target.sessionKey) &&
          resolveAgentIdFromSessionKey(target.sessionKey) === binding.actor.agentId))
    ) {
      // Exact captured paths survive environment changes; an explicit environment still resolves below.
      return binding;
    }
    const options = toDatabaseOptions(
      resolveSqliteScope({
        ...target,
        env: target.env ?? { OPENCLAW_STATE_DIR: path.resolve(binding.actor.path, "../../../..") },
        sessionKey: target.sessionKey ?? "",
      }),
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

/**
 * Capture the shared actor and its current session facts before any history work yields.
 * @internal P7 Knip production exception: remove when runtime acquisition installs the binding.
 */
export function captureIncognitoSessionHistoryBinding(scope: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionEntry?: { sessionId?: string };
}): IncognitoSessionHistoryBinding | undefined {
  const binding = captureIncognitoSessionBinding(scope);
  if (!binding) {
    return undefined;
  }
  const { actor, admissionSignal } = binding;
  const sessionId = scope.sessionId ?? scope.sessionEntry?.sessionId;
  const sessionKey =
    scope.sessionKey ??
    actor.sessions.deadlines().find((entry) => entry.sessionId === sessionId)?.sessionKey;
  const entry = sessionKey ? actor.sessions.readSharing(sessionKey)?.entry : undefined;
  if (!sessionKey || !entry || (sessionId !== undefined && entry.sessionId !== sessionId)) {
    throw new Error("Incognito history requires its current captured session");
  }
  const claim = actor.sessions.captureCurrent(sessionKey);
  const authority = {
    assertCurrent() {
      admissionSignal?.throwIfAborted();
      actor.assertReadable();
      claim.assertCurrent();
    },
  };
  authority.assertCurrent();
  return {
    actor,
    authority,
    target: { sessionKey, sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
  };
}

/** Capture admission once; accepted persistence keeps its actor authority during close. */
export function captureIncognitoSessionOperation(
  target: Parameters<typeof captureIncognitoSessionBinding>[0],
): (IncognitoSessionBinding & { authority: IncognitoSessionAuthority }) | undefined {
  const binding = captureIncognitoSessionBinding(target);
  if (!binding) {
    return undefined;
  }
  binding.admissionSignal?.throwIfAborted();
  return { ...binding, authority: { assertCurrent: () => binding.actor.assertCurrent() } };
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
