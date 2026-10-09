import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseIncognitoAuthority } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { bindPreparedSessionEntryPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoSessionHistoryBinding } from "./session-incognito-history-read.js";
import type { SessionEntry } from "./types.js";

export type IncognitoSessionBinding = Readonly<{
  actor: IncognitoSessionActor;
  admissionSignal?: AbortSignal;
}>;

type IncognitoSessionTarget = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey?: string;
};

const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionBinding"),
  () => new AsyncLocalStorage<IncognitoSessionBinding>(),
);

/** Capture before yielding; a retained binding must never adopt a successor actor. */
export function captureIncognitoSessionBinding(
  target?: IncognitoSessionTarget,
): IncognitoSessionBinding | undefined {
  const binding = bindings.getStore();
  const exactPath = Boolean(
    binding && target?.storePath && path.resolve(target.storePath) === binding.actor.path,
  );
  const explicitTarget =
    binding && target?.storePath
      ? resolveExplicitIncognitoAgentSqliteTarget(target.storePath, target)
      : undefined;
  if (
    !binding ||
    (target &&
      !isIncognitoSessionKey(target.sessionKey) &&
      !exactPath &&
      !explicitTarget &&
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
  const targetSessionId = entry?.sessionId ?? sessionId;
  if (
    !sessionKey ||
    !targetSessionId ||
    (entry && sessionId !== undefined && entry.sessionId !== sessionId)
  ) {
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
    target: {
      sessionKey,
      sessionId: targetSessionId,
      lifecycleRevision: entry?.lifecycleRevision,
      ...(!entry && { allowMissing: true as const }),
    },
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

/** Capture the canonical topology in the injected binding's physical state root. */
export function captureIncognitoSessionTopology() {
  const binding = captureIncognitoSessionBinding();
  if (!binding) {
    return undefined;
  }
  binding.admissionSignal?.throwIfAborted();
  const env = { OPENCLAW_STATE_DIR: path.resolve(binding.actor.path, "../../../..") };
  const entries = captureOpenClawAgentDatabaseExecution.listIncognito(env);
  return {
    env,
    entries,
    assertCurrent(this: void) {
      binding.admissionSignal?.throwIfAborted();
      binding.actor.assertReadable();
      const current = captureOpenClawAgentDatabaseExecution.listIncognito(env);
      if (
        current.length !== entries.length ||
        current.some(
          (entry, index) => entry.identity.incarnation !== entries[index]?.identity.incarnation,
        )
      ) {
        throw new Error("Incognito actor topology changed; prepare it again");
      }
    },
  };
}

/**
 * Target preflight also works without an ambient binding after the atomic cutover.
 * @internal Knip production exception; P7 activation installs unbound SDK refusal.
 */
export function assertIncognitoSessionSyncAccess(
  target: IncognitoSessionTarget | undefined,
  method: string,
  replacement: string,
): void {
  if (
    target &&
    (isIncognitoSessionKey(target.sessionKey) ||
      (target.storePath &&
        isIncognitoOpenClawAgentSqlitePath(target.storePath, {
          agentId: target.agentId ?? resolveAgentIdFromSessionKey(target.sessionKey ?? ""),
          env: target.env,
        })))
  ) {
    throw new IncognitoSessionSyncAccessError(method, replacement);
  }
}

/**
 * Acquire once around the complete consumer lifetime; missing reads never create an actor.
 * @internal Knip production exception; P7 activation installs runtime acquisition.
 */
export async function withAcquiredIncognitoSessionBinding<T>(
  target: IncognitoSessionTarget,
  authority: AgentDatabaseIncognitoAuthority,
  operation: (binding: IncognitoSessionBinding) => Promise<T>,
  request: { existingOnly?: boolean; signal?: AbortSignal } = {},
): Promise<T | undefined> {
  authority.assertCurrent();
  request.signal?.throwIfAborted();
  const retained = captureIncognitoSessionBinding(target);
  const assertCurrent = () => {
    retained?.actor.assertReadable();
    authority.assertCurrent();
  };
  const consume = (binding: IncognitoSessionBinding) =>
    withIncognitoSessionActor(
      binding.actor,
      async () => {
        assertCurrent();
        binding.admissionSignal?.throwIfAborted();
        const result = await operation(binding);
        assertCurrent();
        binding.admissionSignal?.throwIfAborted();
        binding.actor.assertReadable();
        return result;
      },
      binding.admissionSignal,
    );
  const signal =
    request.signal && retained?.admissionSignal
      ? AbortSignal.any([retained.admissionSignal, request.signal])
      : (request.signal ?? retained?.admissionSignal);
  const env = cloneEnvWithPlatformSemantics(
    target.env ??
      (retained && { OPENCLAW_STATE_DIR: path.resolve(retained.actor.path, "../../../..") }) ??
      process.env,
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = toDatabaseOptions(
    resolveSqliteScope({ ...target, env, sessionKey: target.sessionKey ?? "" }),
  );
  if (!isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)) {
    throw new Error("Incognito acquisition requires an incognito session target");
  }
  // The execution owner captures the namespace and incarnation before its first await.
  const actor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: options.agentId,
    env,
    authority: { assertCurrent },
    existingOnly: retained ? true : (request.existingOnly ?? true),
    signal,
  });
  if (!actor) {
    assertCurrent();
    signal?.throwIfAborted();
    return undefined;
  }
  const owner = captureOpenClawAgentDatabaseExecution
    .listIncognito(env)
    .find((entry) => entry.identity.incarnation === actor.identity.incarnation);
  let result: T;
  try {
    if (retained && retained.actor.identity.incarnation !== actor.identity.incarnation) {
      throw new Error("Incognito acquisition cannot replace its captured actor");
    }
    result = await consume({ actor, admissionSignal: signal });
  } finally {
    await actor.release();
  }
  assertCurrent();
  signal?.throwIfAborted();
  if (!owner) {
    throw new Error("Incognito acquisition no longer owns its actor");
  }
  owner.assertCurrent();
  return result;
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
 * @internal Knip production exception; P7 activation installs runtime acquisition.
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

/** Keep one actor read and its authority alive through its asynchronous consumer. */
export function withIncognitoSessionEntry<T>(
  binding: IncognitoSessionBinding,
  sessionKey: string,
  assertCallerCurrent: () => void,
  consume: (entry: SessionEntry | undefined, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const { actor, admissionSignal } = binding;
  const assertCurrent = () => {
    assertCallerCurrent();
    admissionSignal?.throwIfAborted();
    actor.assertReadable();
  };
  let assertSnapshot = assertCurrent;
  return actor.sessions
    .withSharedState(async () => {
      const snapshot = await actor.sessions.read(
        { assertCurrent },
        { sessionKey },
        admissionSignal,
      );
      assertSnapshot = () => {
        assertCurrent();
        snapshot.snapshot.assertCurrent();
      };
      assertSnapshot();
      const result = await consume(snapshot.entry, assertSnapshot);
      assertSnapshot();
      return result;
    })
    .then((result) => {
      assertSnapshot();
      return result;
    });
}

/** List summaries within the selected actor's retained read lifetime. */
export function withIncognitoSessionEntrySummaries<T>(
  binding: IncognitoSessionBinding,
  consume: (entries: SessionEntrySummary[]) => Promise<T>,
): Promise<T> {
  const assertCurrent = () => {
    binding.admissionSignal?.throwIfAborted();
    binding.actor.assertReadable();
  };
  let assertSnapshot = assertCurrent;
  return binding.actor.sessions
    .withSharedState(async () => {
      const result = await binding.actor.sessions.list(
        { assertCurrent },
        { projection: "list" },
        binding.admissionSignal,
      );
      assertSnapshot = result.snapshot.assertCurrent;
      assertSnapshot();
      const value = await consume(result.entries);
      assertSnapshot();
      return value;
    })
    .then((result) => {
      assertSnapshot();
      return result;
    });
}

/** Hold the captured actor roster and snapshots through a complete federation consumer. */
export async function withIncognitoSessionStoreEntries<T>(
  consume: (
    stores: readonly { agentId: string; storePath: string; entries: SessionEntrySummary[] }[],
    assertCurrent: () => void,
  ) => Promise<T>,
  projection: "full" | "list" = "list",
): Promise<T> {
  const binding = captureIncognitoSessionBinding();
  if (!binding) {
    throw new Error("Incognito topology requires its captured binding");
  }
  const topology = captureIncognitoSessionTopology()!;
  const stores: Array<{ agentId: string; storePath: string; entries: SessionEntrySummary[] }> = [];
  const checks: Array<() => void> = [];
  const assertTopology = () => {
    binding.admissionSignal?.throwIfAborted();
    topology.assertCurrent();
  };
  const assertCurrent = () => {
    assertTopology();
    checks.forEach((check) => check());
  };
  const enter = async (index: number): Promise<T> => {
    assertCurrent();
    const target = topology.entries[index];
    if (!target) {
      const result = await consume(stores, assertCurrent);
      assertCurrent();
      return result;
    }
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: target.agentId,
      env: topology.env,
      authority: { assertCurrent: assertTopology },
      existingOnly: true,
      signal: binding.admissionSignal,
    });
    if (!actor) {
      throw new Error("Incognito topology owner ended during acquisition");
    }
    try {
      if (actor.identity.incarnation !== target.identity.incarnation) {
        throw new Error("Incognito topology owner changed during acquisition");
      }
      return await actor.sessions.withSharedState(async () => {
        const read = await actor.sessions.list(
          { assertCurrent: assertTopology },
          { projection },
          binding.admissionSignal,
        );
        checks.push(read.snapshot.assertCurrent);
        stores.push({
          agentId: target.agentId,
          storePath: target.storePath,
          entries: read.entries,
        });
        return enter(index + 1);
      });
    } finally {
      await actor.release();
    }
  };
  return enter(0).then((result) => {
    assertTopology();
    return result;
  });
}
