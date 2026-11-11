import fs from "node:fs";
import path from "node:path";
import { hasAgentRosterProperty, listAgentIds } from "../agents/agent-roster.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureDeletedAgentDatabaseFences } from "../infra/agent-database-readers.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

let reconciliation: Promise<void> = Promise.resolve();
const pendingDepartedReleases = new Map<string, { cancelled: boolean; done: Promise<void> }>();

/** Resolves when a deferred database release finishes. Idle removal has already closed. */
export function waitForDepartedAgentDatabaseRelease(agentId: string): Promise<void> {
  return pendingDepartedReleases.get(normalizeAgentId(agentId))?.done ?? Promise.resolve();
}

function enqueueAgentDatabaseReconciliation(task: () => Promise<void>): Promise<void> {
  const run = reconciliation.then(task, task);
  reconciliation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function explicitAgentIds(config: OpenClawConfig): string[] {
  return hasAgentRosterProperty(config) ? listAgentIds(config) : [];
}

function liveAgentIds(): Set<string> | undefined {
  const live = getRuntimeConfigSnapshot();
  return live ? new Set(listAgentIds(live)) : undefined;
}

function admittedAgentIds(previousConfig: OpenClawConfig, nextConfig: OpenClawConfig): Set<string> {
  const live = getRuntimeConfigSnapshot();
  if (live && live !== previousConfig) {
    return new Set(listAgentIds(live));
  }
  return new Set(listAgentIds(nextConfig));
}

function agentReadmitted(agentId: string): boolean {
  return liveAgentIds()?.has(agentId) === true;
}

export async function reviveAgentDatabasesAfterConfigCommit(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  await enqueueAgentDatabaseReconciliation(() => reviveAgentDatabases(agentIds, warn));
}

export async function reconcileAgentDatabasesAfterConfigCommit(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  warn: (message: string) => void;
}): Promise<void> {
  const { previousConfig, nextConfig, warn } = params;
  await enqueueAgentDatabaseReconciliation(async () => {
    const admitted = admittedAgentIds(previousConfig, nextConfig);
    for (const agentId of admitted) {
      cancelPendingDepartedRelease(agentId);
    }
    for (const agentId of explicitAgentIds(previousConfig)) {
      if (
        admitted.has(agentId) ||
        (await agentDeletionOwnsCleanup(agentId)) ||
        !(await agentHasOpenDatabaseHolder(agentId))
      ) {
        continue;
      }
      try {
        await releaseDepartedAgentDatabase(agentId, previousConfig, warn);
      } catch (error) {
        warn(
          `agent ${agentId} left the roster; database release failed: ${formatErrorMessage(error)}. Restart the Gateway before deleting that agent's files.`,
        );
      }
    }
    await reviveAgentDatabases(
      listAgentIds(nextConfig).filter((agentId) =>
        admittedAgentIds(previousConfig, nextConfig).has(agentId),
      ),
      warn,
    );
  });
}

async function reviveAgentDatabases(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  const deletedAgents = new Set(captureDeletedAgentDatabaseFences().map(([, agentId]) => agentId));
  const returningAgents = agentIds.filter((agentId) => deletedAgents.has(agentId));
  if (!returningAgents.length) {
    return;
  }
  try {
    const { reviveAgentDatabases: revive } = await import("../state/openclaw-agent-db-readers.js");
    await revive(returningAgents);
  } catch (error) {
    warn(
      `agent config committed; worker reader revival will reconcile at next task: ${formatErrorMessage(error)}`,
    );
  }
}

async function agentDeletionOwnsCleanup(agentId: string): Promise<boolean> {
  const { readAgentDeletionJournalAsync } = await import("../state/agent-deletion-journal.js");
  const journal = await readAgentDeletionJournalAsync(agentId);
  return journal !== undefined && !journal.cleanupCompleted;
}

async function agentHasOpenDatabaseHolder(agentId: string): Promise<boolean> {
  const normalized = normalizeAgentId(agentId);
  const [{ agentDatabaseLifecycle }, { hasOpenClawAgentDatabaseAsyncResources }] =
    await Promise.all([
      import("../state/openclaw-agent-db-lifecycle.js"),
      import("../state/openclaw-agent-db-resources.js"),
    ]);
  for (const database of agentDatabaseLifecycle.databases.values()) {
    if (database.agentId === normalized && database.db.isOpen) {
      return true;
    }
  }
  return hasOpenClawAgentDatabaseAsyncResources({ agentId: normalized });
}

async function releaseDepartedAgentDatabase(
  agentId: string,
  previousConfig: OpenClawConfig,
  warn: (message: string) => void,
): Promise<void> {
  const normalized = normalizeAgentId(agentId);
  const running = await captureDepartedAgentWork(normalized);
  if (running) {
    deferDepartedAgentRelease(normalized, running.settled, previousConfig, warn);
    return;
  }
  await closeDepartedAgentResources(normalized, previousConfig);
}

function agentDatabasePaths(
  agentId: string,
  canonical: string,
  paths: {
    resolveOpenClawAgentSqlitePath: (options: { agentId: string }) => string;
    resolveIncognitoOpenClawAgentSqlitePath: (options: { agentId: string }) => string;
  },
): string[] {
  return [
    canonical,
    paths.resolveOpenClawAgentSqlitePath({ agentId }),
    paths.resolveIncognitoOpenClawAgentSqlitePath({ agentId }),
  ];
}

async function awaitDepartedDurableWrites(databasePaths: readonly string[]): Promise<void> {
  const { drainOpenClawAgentWriteQueues } =
    await import("../state/openclaw-agent-write-admission.js");
  const physical = new Set(databasePaths.map((pathname) => path.resolve(pathname)));
  for (const pathname of databasePaths) {
    try {
      physical.add(fs.realpathSync(pathname));
    } catch {
      // Missing files still name their writer queue by the lexical path.
    }
  }
  await drainOpenClawAgentWriteQueues((storePath) => {
    const resolved = path.resolve(storePath);
    if (physical.has(resolved)) {
      return true;
    }
    try {
      return physical.has(fs.realpathSync(resolved));
    } catch {
      return false;
    }
  });
}

async function closeDepartedAgentResources(
  agentId: string,
  previousConfig: OpenClawConfig,
): Promise<void> {
  const normalized = normalizeAgentId(agentId);
  if (agentReadmitted(normalized)) {
    return;
  }
  const [
    { resolveEffectiveAgentDir },
    { retirePreparedModelRuntimeAgent },
    { closeActiveMemorySearchManagerCore },
    { releaseSessionHistoryWorkerDatabases },
    sqlitePaths,
    { agentDatabaseLifecycle, closeOpenClawAgentDatabaseByPathAsync },
    { closeDeletedAgentDatabases },
  ] = await Promise.all([
    import("../agents/agent-scope-config.js"),
    import("../agents/prepared-model-runtime.js"),
    import("../plugins/memory-runtime.js"),
    import("../config/sessions/session-history-worker-idle.js"),
    import("../state/openclaw-agent-db.paths.js"),
    import("../state/openclaw-agent-db-lifecycle.js"),
    import("../state/openclaw-agent-db-readers.js"),
  ]);
  const agentDir = resolveEffectiveAgentDir(previousConfig, normalized);
  const canonical = sqlitePaths.resolveOpenClawAgentSqlitePath({
    agentId: normalized,
    path: path.join(agentDir, "openclaw-agent.sqlite"),
  });
  const knownPaths = agentDatabasePaths(normalized, canonical, sqlitePaths);
  await awaitDepartedDurableWrites(knownPaths);
  if (agentReadmitted(normalized)) {
    return;
  }
  if (!(await releaseSessionHistoryWorkerDatabases({ agentId: normalized, paths: knownPaths }))) {
    return;
  }
  await closeActiveMemorySearchManagerCore({ cfg: previousConfig, agentId: normalized });
  const readerPaths = [
    ...new Set([
      ...knownPaths,
      ...[...agentDatabaseLifecycle.databases.values()]
        .filter((database) => database.agentId === normalized && database.db.isOpen)
        .map((database) => database.path),
    ]),
  ];
  await retirePreparedModelRuntimeAgent({ agentId: normalized, agentDirs: [agentDir] });
  if (agentReadmitted(normalized)) {
    return;
  }
  for (const pathname of readerPaths) {
    agentDatabaseLifecycle.databases.get(path.resolve(pathname))?.walMaintenance.checkpoint();
  }
  for (const pathname of readerPaths) {
    await closeOpenClawAgentDatabaseByPathAsync(pathname, normalized);
  }
  if (agentReadmitted(normalized)) {
    return;
  }
  await closeDeletedAgentDatabases(normalized, readerPaths, {
    assertCurrentFinal() {
      if (agentReadmitted(normalized)) {
        throw new Error(`Agent ${normalized} returned to the roster during database release.`);
      }
    },
    async assertCurrentAsync() {
      this.assertCurrentFinal();
    },
  });
}

function cancelPendingDepartedRelease(agentId: string): void {
  const pending = pendingDepartedReleases.get(normalizeAgentId(agentId));
  if (!pending) {
    return;
  }
  pending.cancelled = true;
  pendingDepartedReleases.delete(normalizeAgentId(agentId));
}

async function captureDepartedAgentWork(
  agentId: string,
): Promise<{ settled: Promise<void> } | undefined> {
  const [
    { captureAgentWorkAdmissionSettlement },
    { nativeAttemptAttachments },
    { captureEmbeddedRunDrainTarget },
  ] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../agents/embedded-agent-runner/run-state.js"),
    import("../agents/embedded-agent-runner/runs.js"),
  ]);
  const runs = [];
  for (const attachment of nativeAttemptAttachments()) {
    const run = captureEmbeddedRunDrainTarget(attachment, { agentId });
    if (run?.isActive()) {
      runs.push(run);
    }
  }
  const effects = captureAgentWorkAdmissionSettlement({ agentId });
  if (!runs.length && !effects.pending) {
    return undefined;
  }
  return {
    settled: Promise.all([
      ...runs.map((run) => run.waitForEnd(null).finally(() => run.release())),
      ...(effects.pending ? [effects.released] : []),
    ]).then(() => awaitDepartedTerminalPersistence(agentId)),
  };
}

function deferDepartedAgentRelease(
  agentId: string,
  settled: Promise<void>,
  previousConfig: OpenClawConfig,
  warn: (message: string) => void,
): void {
  if (pendingDepartedReleases.has(agentId)) {
    return;
  }
  const pending = { cancelled: false, done: Promise.resolve() };
  pending.done = settled
    .then(async () => {
      if (pending.cancelled || pendingDepartedReleases.get(agentId) !== pending) {
        return;
      }
      if (agentReadmitted(agentId)) {
        return;
      }
      await closeDepartedAgentResources(agentId, previousConfig);
    })
    .catch((error: unknown) => {
      if (!pending.cancelled) {
        warn(
          `agent ${agentId} left the roster; database release failed: ${formatErrorMessage(error)}. Restart the Gateway before deleting that agent's files.`,
        );
      }
    })
    .finally(() => {
      if (pendingDepartedReleases.get(agentId) === pending) {
        pendingDepartedReleases.delete(agentId);
      }
    });
  pendingDepartedReleases.set(agentId, pending);
}

async function awaitDepartedTerminalPersistence(agentId: string): Promise<void> {
  const { getRpcSourceIdentity, listRpcSourceEntries } =
    await import("../sessions/session-controller.rpc-sources.js");
  const current = () => {
    const work: Promise<unknown>[] = [];
    let awaitingOwner = false;
    for (const [, source] of listRpcSourceEntries()) {
      const identity = getRpcSourceIdentity(source);
      const owner = identity.agentId ?? parseAgentSessionKey(identity.sessionKey)?.agentId;
      if (!owner || normalizeAgentId(owner) !== agentId) {
        continue;
      }
      const persistence = source.adapter.projectSessionTerminalPersistence;
      if (persistence) {
        work.push(persistence);
      } else if (source.adapter.projectSessionTerminalPending === true) {
        awaitingOwner = true;
      }
      for (const pending of source.input.custody.work ?? []) {
        work.push(pending);
      }
    }
    return { work, awaitingOwner };
  };
  let { work, awaitingOwner } = current();
  if (work.length === 0 && awaitingOwner) {
    await Promise.resolve();
    ({ work, awaitingOwner } = current());
    if (work.length === 0 && awaitingOwner) {
      throw new Error(`Agent ${agentId} terminal session persistence did not start.`);
    }
  }
  if (work.length > 0) {
    await Promise.allSettled(work);
    const followUp = current().work;
    if (followUp.length > 0) {
      await Promise.allSettled(followUp);
    }
  }
}
