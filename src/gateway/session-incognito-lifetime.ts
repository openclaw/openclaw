import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../shared/incognito-session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  listOpenIncognitoAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";

const CLEANUP_RETRY_MS = 60_000;

type IncognitoSessionDeadline = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
  expiresAt: number;
  source: { identity: string | symbol; assertCurrent(): void; assertSettlingCurrent?(): void };
};

type DeleteIncognitoSession = (
  deadline: IncognitoSessionDeadline,
  assertCurrent: () => void,
) => Promise<void>;

/** Deadline scheduling only: the session deletion owner drains work and removes data. */
function createIncognitoSessionDeadlineOwner(params: {
  logWarning: (message: string) => void;
  scheduler: GatewayScheduler;
  deleteSession: DeleteIncognitoSession;
}) {
  type Deadline = IncognitoSessionDeadline & { job?: GatewayScheduledJob };
  const scheduler = params.scheduler.scope();
  const restartSignal = getGatewayRestartDrainSignal();
  const deadlines = new Map<string, Deadline>();
  const current = (deadline: Deadline, accepted = false) => {
    const registered = deadlines.get(deadline.sessionKey);
    const retaining = accepted && deadline.source.assertSettlingCurrent !== undefined;
    if (
      (!retaining && (scheduler.signal.aborted || restartSignal.aborted)) ||
      (registered !== deadline && (!retaining || registered !== undefined))
    ) {
      return false;
    }
    try {
      // An acknowledged deletion may remove its own row and deadline before cleanup settles.
      if (accepted && deadline.source.assertSettlingCurrent) {
        deadline.source.assertSettlingCurrent();
      } else {
        deadline.source.assertCurrent();
      }
      return true;
    } catch {
      return false;
    }
  };

  const retire = (deadline: Deadline) => {
    deadline.job?.cancel();
    if (deadlines.get(deadline.sessionKey) === deadline) {
      deadlines.delete(deadline.sessionKey);
    }
  };

  const schedule = (deadline: Deadline, delayMs?: number) => {
    deadline.job = scheduler.schedule({
      id: `incognito-expiry:${deadline.sessionKey}`,
      ...(delayMs === undefined ? { atMs: deadline.expiresAt } : { delayMs }),
      run: async () => {
        if (!current(deadline)) {
          retire(deadline);
          return;
        }
        let accepted = true;
        try {
          await params.deleteSession(deadline, () => {
            if (!accepted || !current(deadline, true)) {
              throw new Error("Incognito expiry no longer owns this session.");
            }
          });
          retire(deadline);
        } catch {
          if (current(deadline)) {
            params.logWarning("Incognito session expiry could not finish cleanup; will retry.");
            schedule(deadline, CLEANUP_RETRY_MS);
          } else {
            retire(deadline);
          }
        } finally {
          accepted = false;
        }
      },
    });
  };

  return {
    observe(fact: IncognitoSessionDeadline) {
      if (scheduler.signal.aborted || restartSignal.aborted) {
        return;
      }
      fact.source.assertCurrent();
      const existing = deadlines.get(fact.sessionKey);
      if (
        existing?.source.identity === fact.source.identity &&
        existing.sessionId === fact.sessionId
      ) {
        // Activity, archive, rewind, and metadata edits never renew a lifetime.
        return;
      }
      if (existing) {
        retire(existing);
      }
      const deadline: Deadline = { ...fact };
      deadlines.set(fact.sessionKey, deadline);
      schedule(deadline);
    },
    forget(sessionKey: string) {
      const existing = deadlines.get(sessionKey);
      if (existing) {
        retire(existing);
      }
    },
    stop: async () => {
      scheduler.beginClose();
      await scheduler.stop();
      deadlines.clear();
    },
  };
}

/** Production acquisition remains native until every incognito caller moves together. */
export function startIncognitoSessionLifetime(params: {
  context: GatewayRequestContext;
  logWarning: (message: string) => void;
  scheduler: GatewayScheduler;
}): GatewayPostReadySidecarHandle {
  const owner = createIncognitoSessionDeadlineOwner({
    ...params,
    async deleteSession(deadline, assertCurrent) {
      const { deleteGatewaySession } = await import("./server-methods/sessions-delete.js");
      const result = await deleteGatewaySession({
        params: {
          key: deadline.sessionKey,
          agentId: deadline.agentId,
          expectedSessionId: deadline.sessionId,
        },
        client: null,
        context: params.context,
        assertCurrent,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  });
  const runInOwner = AsyncLocalStorage.snapshot();
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  const restartSignal = getGatewayRestartDrainSignal();
  let active = true;
  const observe = (change: SessionRowChange) => {
    if (!active || restartSignal.aborted || !("sessionKey" in change)) {
      return;
    }
    const { sessionKey, agentId, storePath } = change;
    if (
      !isIncognitoSessionKey(sessionKey) ||
      !agentId ||
      storePath !== resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    ) {
      return;
    }
    // Projection observers run after committed facts settle. Resolve only this
    // owner's already-open connection and exact key; never admit a store here.
    const database = getOpenClawAgentDatabaseIfOpen({ agentId, path: storePath, env });
    const entry = database
      ? loadSessionEntryReadOnly({ agentId, sessionKey, storePath, env })
      : undefined;
    if (!database || !entry) {
      owner.forget(sessionKey);
      return;
    }
    const expiresAt = resolveIncognitoSessionExpiresAt(entry);
    if (!database.db.isOpen || expiresAt === undefined) {
      return;
    }
    owner.observe({
      sessionKey,
      agentId,
      sessionId: entry.sessionId,
      source: {
        identity: readOpenClawAgentDatabaseIdentity(database).identity,
        assertCurrent() {
          if (
            !database.db.isOpen ||
            getOpenClawAgentDatabaseIfOpen({ agentId, path: storePath, env }) !== database
          ) {
            throw new Error("Incognito expiry lost its original database");
          }
        },
      },
      expiresAt,
    });
  };

  const unsubscribe = sessionChanges.subscribeProjection((change) =>
    runInOwner(() => observe(change)),
  );
  // A sibling Gateway can start after creation and outlive the first scheduler.
  // Hydrate only this owner's already-open memory stores, then follow publications.
  for (const target of listOpenIncognitoAgentDatabases()) {
    if (target.storePath !== resolveIncognitoOpenClawAgentSqlitePath({ ...target, env })) {
      continue;
    }
    for (const { sessionKey } of listSessionEntriesReadOnly({ ...target, env, clone: false })) {
      observe({ ...target, sessionKey });
    }
  }
  return {
    stop: async () => {
      active = false;
      unsubscribe();
      await owner.stop();
    },
  };
}

/**
 * Inactive: activation supplies its captured actor and the bound Gateway deletion owner.
 * @internal Knip production exception; atomic activation installs this sidecar.
 */
export function startIncognitoActorSessionLifetime(params: {
  actor: IncognitoSessionActor;
  scheduler: GatewayScheduler;
  logWarning: (message: string) => void;
  deleteSession: DeleteIncognitoSession;
}): GatewayPostReadySidecarHandle {
  const { actor } = params;
  actor.assertCurrent();
  const owner = createIncognitoSessionDeadlineOwner({
    ...params,
    deleteSession: (deadline, assertCurrent) =>
      actor.sessions.withSharedState(() => params.deleteSession(deadline, assertCurrent)),
  });
  const runInOwner = AsyncLocalStorage.snapshot();
  let active = true;
  const observe = (change?: SessionRowChange) => {
    if (!active) {
      return;
    }
    if (change && (!("sessionKey" in change) || change.storePath !== actor.path)) {
      return;
    }
    const facts = actor.sessions.deadlines();
    for (const fact of facts) {
      if (!change || ("sessionKey" in change && change.sessionKey === fact.sessionKey)) {
        owner.observe({ ...fact, agentId: actor.agentId });
      }
    }
    if (
      change &&
      "sessionKey" in change &&
      !facts.some((fact) => fact.sessionKey === change.sessionKey)
    ) {
      owner.forget(change.sessionKey);
    }
  };
  observe();
  const unsubscribe = sessionChanges.subscribeProjection((change) =>
    runInOwner(() => observe(change)),
  );
  return {
    async stop() {
      active = false;
      unsubscribe();
      await owner.stop();
    },
  };
}

/**
 * Existing-only topology composition; production keeps the native sidecar until atomic activation.
 * @internal Knip production exception; P7 installs this sidecar with actor acquisition.
 */
export function startIncognitoActorsSessionLifetime(params: {
  context: GatewayRequestContext;
  scheduler: GatewayScheduler;
  logWarning: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): GatewayPostReadySidecarHandle {
  const env = {
    ...(params.env ?? process.env),
    OPENCLAW_STATE_DIR: resolveStateDir(params.env ?? process.env),
  };
  const runInOwner = AsyncLocalStorage.snapshot();
  const retained = new Map<
    string,
    {
      identity: string;
      stop(): Promise<void>;
    }
  >();
  let active = true;
  let tail = Promise.resolve();
  const observe = () => {
    if (!active) {
      return;
    }
    // Capture topology before yielding; acquisition cannot adopt a replacement incarnation.
    const targets = captureOpenClawAgentDatabaseExecution.listIncognito(env);
    tail = tail
      .then(async () => {
        if (!active) {
          return;
        }
        const current = new Map(targets.map((target) => [target.storePath, target]));
        const retirements = new Map<string, Promise<void>>();
        for (const [pathname, owner] of retained) {
          if (current.get(pathname)?.identity.incarnation !== owner.identity) {
            retirements.set(
              pathname,
              owner.stop().then(() => {
                retained.delete(pathname);
              }),
            );
          }
        }
        const acquisitions = targets.map(async (target) => {
          await retirements.get(target.storePath);
          if (!active || retained.has(target.storePath)) {
            return;
          }
          target.assertCurrent();
          const actor = await captureOpenClawAgentDatabaseExecution({
            kind: "ephemeral",
            agentId: target.agentId,
            env,
            existingOnly: true,
            authority: { assertCurrent: target.assertCurrent },
          });
          if (!actor) {
            return;
          }
          let installed = false;
          try {
            target.assertCurrent();
            if (!active || actor.identity.incarnation !== target.identity.incarnation) {
              return;
            }
            const sidecar = startIncognitoActorSessionLifetime({
              ...params,
              actor,
              deleteSession: (deadline, assertCurrent) =>
                withIncognitoSessionBinding({ actor }, async () => {
                  const { deleteGatewaySession } =
                    await import("./server-methods/sessions-delete.js");
                  assertCurrent();
                  const result = await deleteGatewaySession({
                    params: {
                      key: deadline.sessionKey,
                      agentId: deadline.agentId,
                      expectedSessionId: deadline.sessionId,
                    },
                    client: null,
                    context: params.context,
                    assertCurrent,
                  });
                  if (!result.ok) {
                    throw new Error(result.error.message);
                  }
                }),
            });
            retained.set(target.storePath, {
              identity: actor.identity.incarnation,
              async stop() {
                await sidecar.stop();
                await actor.release();
              },
            });
            installed = true;
          } finally {
            if (!installed) {
              await actor.release();
            }
          }
        });
        const settled = await Promise.allSettled([...retirements.values(), ...acquisitions]);
        if (settled.some((result) => result.status === "rejected")) {
          params.logWarning("Incognito expiry could not reconcile a captured actor.");
        }
      })
      .catch(() => {
        params.logWarning("Incognito expiry could not reconcile its captured actors.");
      });
  };
  const unsubscribe = sessionChanges.subscribeProjection(() => runInOwner(observe));
  observe();
  return {
    async stop() {
      active = false;
      unsubscribe();
      await tail;
      const stopped = await Promise.allSettled(
        [...retained].map(async ([pathname, owner]) => {
          await owner.stop();
          retained.delete(pathname);
        }),
      );
      const failures = stopped.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Incognito expiry owners could not finish cleanup");
      }
    },
  };
}
