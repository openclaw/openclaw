import path from "node:path";
import { hasAgentRosterProperty, listAgentIds } from "../agents/agent-roster.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureDeletedAgentDatabaseFences } from "../infra/agent-database-readers.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";

let reconciliation: Promise<void> = Promise.resolve();
const departedWorkAdmissions = new Map<string, () => void>();

/** One roster publication at a time, so a later commit cannot lose to an older close. */
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

/**
 * Follow a snapshot published after this commit captured its predecessor.
 * An unchanged snapshot still belongs to that predecessor, so this commit's
 * roster is authoritative until a later publication replaces it.
 */
function admittedAgentIds(previousConfig: OpenClawConfig, nextConfig: OpenClawConfig): Set<string> {
  const live = getRuntimeConfigSnapshot();
  if (live && live !== previousConfig) {
    return new Set(listAgentIds(live));
  }
  return new Set(listAgentIds(nextConfig));
}

/** A roster that admits an agent again may adopt databases its deletion left behind. */
export async function reviveAgentDatabasesAfterConfigCommit(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  await enqueueAgentDatabaseReconciliation(() => reviveAgentDatabases(agentIds, warn));
}

/**
 * Closing a removed agent's holders keeps its files. A later roster admission
 * clears the fence; agents.delete remains the path that purges stored history.
 */
export async function reconcileAgentDatabasesAfterConfigCommit(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  warn: (message: string) => void;
}): Promise<void> {
  const { previousConfig, nextConfig, warn } = params;
  await enqueueAgentDatabaseReconciliation(async () => {
    for (const agentId of explicitAgentIds(previousConfig)) {
      if (admittedAgentIds(previousConfig, nextConfig).has(agentId)) {
        continue;
      }
      if (!(await agentHasOpenDatabaseHolder(agentId))) {
        continue;
      }
      try {
        await releaseDepartedAgentDatabase(agentId, previousConfig, nextConfig);
      } catch (error) {
        warn(
          `agent ${agentId} left the roster; database release failed: ${formatErrorMessage(error)}. Restart the Gateway before deleting that agent's files.`,
        );
      }
      if (admittedAgentIds(previousConfig, nextConfig).has(agentId)) {
        await reviveAgentDatabases([agentId], warn);
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
    for (const agentId of returningAgents) {
      releaseDepartedWorkAdmission(agentId);
    }
  } catch (error) {
    warn(
      `agent config committed; worker reader revival will reconcile at next task: ${formatErrorMessage(error)}`,
    );
  }
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
  nextConfig: OpenClawConfig,
): Promise<void> {
  const normalized = normalizeAgentId(agentId);
  await blockDepartedAgentWork(normalized);
  const [
    { prepareAgentDeleteDatabases, isPathOwnedBySurvivingAgent },
    { resolveEffectiveAgentDir },
    { retirePreparedModelRuntimeAgent },
    { closeActiveMemorySearchManagerCore },
    { retireSessionHistoryWorkerDatabases },
    paths,
    { closeOpenClawAgentDatabaseByPathAsync },
    { closeDeletedAgentDatabases },
  ] = await Promise.all([
    import("../agents/agent-delete-databases.js"),
    import("../agents/agent-scope-config.js"),
    import("../agents/prepared-model-runtime.js"),
    import("../plugins/memory-runtime.js"),
    import("../config/sessions/session-transcript-worker-resources.js"),
    import("../state/openclaw-agent-db.paths.js"),
    import("../state/openclaw-agent-db-lifecycle.js"),
    import("../state/openclaw-agent-db-readers.js"),
  ]);
  const agentDir = resolveEffectiveAgentDir(previousConfig, normalized);
  const canonical = paths.resolveOpenClawAgentSqlitePath({
    agentId: normalized,
    path: path.join(agentDir, "openclaw-agent.sqlite"),
  });
  await retireSessionHistoryWorkerDatabases({
    agentId: normalized,
    paths: [
      canonical,
      paths.resolveOpenClawAgentSqlitePath({ agentId: normalized }),
      paths.resolveIncognitoOpenClawAgentSqlitePath({ agentId: normalized }),
    ],
  });
  await closeActiveMemorySearchManagerCore({ cfg: previousConfig, agentId: normalized });

  let readerPaths = [canonical];
  let agentDirs = [agentDir];
  let planningError: Error | undefined;
  try {
    const plan = await prepareAgentDeleteDatabases(nextConfig, normalized, agentDir);
    if (plan.readerPaths.length > 0) {
      readerPaths = plan.readerPaths;
    }
    agentDirs = plan.agentDirs;
  } catch (error) {
    planningError = error instanceof Error ? error : new Error(formatErrorMessage(error));
    if (!isPathOwnedBySurvivingAgent(nextConfig, normalized, canonical)) {
      await closeOpenClawAgentDatabaseByPathAsync(canonical, normalized);
    }
  }
  await retirePreparedModelRuntimeAgent({ agentId: normalized, agentDirs });
  if (liveAgentIds()?.has(normalized)) {
    if (planningError) {
      throw planningError;
    }
    return;
  }
  await closeDeletedAgentDatabases(normalized, readerPaths, {
    assertCurrentFinal() {
      if (liveAgentIds()?.has(normalized)) {
        throw new Error(`Agent ${normalized} returned to the roster during database release.`);
      }
    },
    async assertCurrentAsync() {
      this.assertCurrentFinal();
    },
  });
  if (planningError) {
    throw planningError;
  }
}

/** New session writes stop before the database close. Re-admission releases the fence. */
async function blockDepartedAgentWork(agentId: string): Promise<void> {
  if (departedWorkAdmissions.has(agentId)) {
    return;
  }
  const [{ closeAgentWorkAdmissions }, { AgentDeletionPendingError }] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../sessions/session-agent-work-admission.js"),
  ]);
  try {
    departedWorkAdmissions.set(
      agentId,
      closeAgentWorkAdmissions({
        agentId,
        reason: new AgentDeletionPendingError(
          `Agent ${agentId} left the roster and its database is closing.`,
        ),
      }),
    );
  } catch (error) {
    // Reload can observe the departed agent's own turn. The database fence still
    // refuses a later open; this call only cannot be issued from inside that turn.
    if (error instanceof Error && error.message.includes("from its own active turn")) {
      return;
    }
    throw error;
  }
}

function releaseDepartedWorkAdmission(agentId: string): void {
  const release = departedWorkAdmissions.get(normalizeAgentId(agentId));
  if (!release) {
    return;
  }
  departedWorkAdmissions.delete(normalizeAgentId(agentId));
  release();
}
