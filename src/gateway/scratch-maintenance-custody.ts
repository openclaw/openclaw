import os from "node:os";
import path from "node:path";
import { resolveAgentRunCwd, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { readWorktreeCleanupState } from "../agents/worktrees/registry-read.js";
import {
  captureWorktreeRegistryAuthority,
  captureWorktreeRunEndContext,
} from "../agents/worktrees/run-end-lifecycle.js";
import { readResolvedSessionStoreTargetsInWorker } from "../config/sessions/session-accessor.entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import type { ScratchCleanupTarget } from "../infra/scratch-cleanup.js";
import { listProjectRegistry } from "../projects/project-registry.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import { listActiveReplyRunSessionKeys } from "../sessions/session-controller.queries.js";
import {
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
} from "../sessions/session-row-changes.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";

function currentLocalRunSessions() {
  const keys = new Set(listActiveReplyRunSessionKeys());
  const needsBinding = new Set(keys);
  const sourcePaths = new Map<string, string[]>();
  for (const runId of listLiveAgentRunIds()) {
    if (hasAgentRunContextExecutionOwner(runId)) {
      const key = getAgentRunContext(runId)?.sessionKey;
      if (!key) {
        throw new Error("Scratch cleanup deferred: a live run has no checkout binding yet");
      }
      keys.add(key);
      needsBinding.add(key);
    }
  }
  for (const mailbox of sessionControllerMailboxes()) {
    if (!mailbox.entries.length && !mailbox.claim && !mailbox.droppedCount) {
      continue;
    }
    const key = mailbox.owner.target?.sessionKey ?? mailbox.key;
    keys.add(key);
    const sources = [
      ...mailbox.entries.flatMap((input) => input.source ?? []),
      ...(mailbox.claim?.sources ?? []),
    ];
    // Bound queued sources retain their actual checkout alongside the current
    // execution or any reservation that has not selected its directories yet.
    const paths = sourcePaths.get(key) ?? [];
    for (const { run } of sources) {
      for (const value of [run.workspaceDir, run.cwd, run.sessionRoot]) {
        if (value) {
          paths.push(value);
        }
      }
    }
    sourcePaths.set(key, paths);
    if (!sources.length || mailbox.droppedCount || mailbox.entries.some((input) => !input.source)) {
      needsBinding.add(key);
    }
  }
  return { keys, sourcePaths, needsBinding };
}

/** Read only current run bindings; scratch never consults transcripts or artifact references. */
export async function prepareScratchMaintenanceTargets(
  cfg: OpenClawConfig,
): Promise<{ targets: ScratchCleanupTarget[]; release: () => void }> {
  const context = captureWorktreeRunEndContext(process.env);
  const assertInventory = captureWorktreeRegistryAuthority(context, [
    { id: "*", fields: ["identity", "removal", "leases"] },
  ]);
  const placementService = resolveSessionWorkerPlacementContext().workerSessionPlacementService;
  if (!placementService?.prepareMaintenancePlacements) {
    throw new Error("Scratch cleanup deferred: worker run custody is unavailable");
  }
  const placements = await placementService.prepareMaintenancePlacements();
  const changedKeys = new Set<string>();
  let allChanged = false;
  let runsChanged = true;
  const stopMetrics = onGatewayWorkMetricsChanged(() => {
    runsChanged = true;
  });
  const stop = sessionChanges.subscribeFacts((change) => {
    runsChanged = true;
    if (change.scope === "transcript" || !sessionChangeScopeAffectsStoredRows(change)) {
      return;
    }
    if ("all" in change) {
      allChanged = true;
    } else if (change.facts?.kind !== "unchanged") {
      changedKeys.add(change.sessionKey);
    }
  });
  const release = () => {
    stop();
    stopMetrics();
    placements.release();
  };
  try {
    const [state, projects] = await Promise.all([
      readWorktreeCleanupState(process.env),
      listProjectRegistry(cfg),
    ]);
    assertInventory();
    const roots = new Map<string, string[]>();
    for (const record of state.records) {
      if (record.removedAt === undefined) {
        const root = path.resolve(record.path);
        const ids = roots.get(root) ?? [];
        ids.push(record.id);
        roots.set(root, ids);
      }
    }
    for (const project of projects) {
      const root = path.resolve(project.repoRoot);
      if (!roots.has(root)) {
        roots.set(root, []);
      }
    }
    // Inventory coherence is checked once; unrelated worktree turns must not
    // invalidate this checkout during a paced sweep.
    const guards = new Map(
      Array.from(roots, ([root, ids]) => [
        root,
        captureWorktreeRegistryAuthority(
          context,
          ids.map((id) => ({
            id,
            fields: ["identity", "removal", "leases"],
          })),
        ),
      ]),
    );
    const runSessions = () => {
      placements.assertCurrent();
      const current = currentLocalRunSessions();
      for (const placement of placements.placements) {
        if (placement.turnClaim) {
          current.keys.add(placement.sessionKey);
          current.needsBinding.add(placement.sessionKey);
        }
      }
      return current;
    };
    const pathsByKey = new Map<string, string[]>();
    const worktreesById = new Map(state.records.map((record) => [record.id, record.path]));
    const prepare = async () => {
      if (!runsChanged && !allChanged) {
        return;
      }
      if (allChanged) {
        pathsByKey.clear();
        changedKeys.clear();
        allChanged = false;
      }
      const current = runSessions();
      const missing = [...current.needsBinding].filter(
        (key) => !pathsByKey.has(key) || changedKeys.has(key),
      );
      if (!missing.length) {
        return;
      }
      for (const key of missing) {
        pathsByKey.delete(key);
        changedKeys.delete(key);
      }
      const bindings = await readResolvedSessionStoreTargetsInWorker(
        { cfg, sessionKeys: missing },
        "list",
      );
      for (const [key, target] of bindings) {
        if (allChanged || changedKeys.has(key)) {
          continue;
        }
        const entry = target.entry;
        const paths = [
          resolveIngressWorkspaceOverrideForSessionRun({
            spawnedBy: entry?.spawnedBy,
            workspaceDir: entry?.spawnedWorkspaceDir,
            cwd: entry?.spawnedCwd,
          }) ?? resolveAgentWorkspaceDir(cfg, target.agentId),
          entry?.spawnedCwd ?? resolveAgentRunCwd(cfg, target.agentId),
          entry?.sessionRoot,
          entry?.worktree && worktreesById.get(entry.worktree.id),
        ].filter((value): value is string => Boolean(value));
        pathsByKey.set(key, paths);
        pathsByKey.set(target.canonicalKey, paths);
      }
      runsChanged = true;
    };
    await prepare();
    const liveScopes = new Set(state.leases.liveScopes);
    let liveRoots = new Set<string>();
    const isLive = (root: string, worktreeIds: readonly string[]) => {
      guards.get(root)!();
      placements.assertCurrent();
      if (allChanged) {
        throw new Error("Scratch cleanup deferred: session checkout bindings changed");
      }
      // This pass consumes prepared custody facts until their owners publish a change.
      // Checking each unlink does not rescan every run or query session storage.
      if (runsChanged) {
        const currentRoots = new Set<string>();
        const current = runSessions();
        for (const key of current.keys) {
          const binding = current.needsBinding.has(key)
            ? !changedKeys.has(key)
              ? pathsByKey.get(key)
              : undefined
            : [];
          if (!binding) {
            throw new Error(
              "Scratch cleanup deferred: a live run requires a fresh checkout binding",
            );
          }
          for (const runPath of [...binding, ...(current.sourcePaths.get(key) ?? [])]) {
            let directory = path.resolve(runPath);
            for (;;) {
              if (roots.has(directory)) {
                currentRoots.add(directory);
              }
              const parent = path.dirname(directory);
              if (parent === directory) {
                break;
              }
              directory = parent;
            }
          }
        }
        liveRoots = currentRoots;
        runsChanged = false;
      }
      return worktreeIds.some((id) => liveScopes.has(`worktree-run:${id}`)) || liveRoots.has(root);
    };
    const targets: ScratchCleanupTarget[] = Array.from(roots, ([root, ids]) => ({
      root,
      kind: "checkout",
      prepare,
      isLive: () => isLive(root, ids),
    }));
    // Coverage has no checkout/run binding; unrelated activity is not a retention veto.
    targets.push({ root: os.tmpdir(), kind: "coverage", isLive: () => false });
    return { targets, release };
  } catch (error) {
    release();
    throw error;
  }
}
