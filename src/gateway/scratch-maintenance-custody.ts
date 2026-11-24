import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { hasActiveContainerUsage } from "../agents/sandbox/container-usage.js";
import { readRegistry as readSandboxRegistry } from "../agents/sandbox/registry.js";
import { resolvePreparedSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxSession } from "../agents/sandbox/session-selection.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
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
import { resolveUserPath } from "../infra/home-dir.js";
import type { ScratchCleanupTarget } from "../infra/scratch-cleanup.js";
import { listProjectRegistry } from "../projects/project-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import {
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
} from "../sessions/session-row-changes.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";

function currentLocalRunSessions(cfg: OpenClawConfig) {
  let unboundSince = Infinity;
  const unboundPaths: Array<string | undefined> = [];
  const keys = new Set<string>();
  const startedAtByKey = new Map<string, number>();
  for (const operation of activeSessionOperations()) {
    keys.add(operation.key);
    startedAtByKey.set(
      operation.key,
      Math.min(startedAtByKey.get(operation.key) ?? Infinity, operation.startedAtMs),
    );
  }
  const needsBinding = new Set(keys);
  const sourcePaths = new Map<string, string[]>();
  for (const runId of listLiveAgentRunIds()) {
    if (hasAgentRunContextExecutionOwner(runId)) {
      const run = getAgentRunContext(runId)!;
      const operation = run.sessionKey ? undefined : findSessionControllerOperationByRunId(runId);
      const key = run.sessionKey ?? operation?.key;
      if (!key) {
        unboundSince = Math.min(unboundSince, run.registeredAt ?? 0);
        if (run.agentId) {
          unboundPaths.push(
            resolveAgentWorkspaceDir(cfg, run.agentId),
            resolveAgentRunCwd(cfg, run.agentId),
          );
        }
        continue;
      }
      keys.add(key);
      startedAtByKey.set(key, Math.min(startedAtByKey.get(key) ?? Infinity, run.registeredAt ?? 0));
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
  return { keys, sourcePaths, needsBinding, unboundSince, unboundPaths, startedAtByKey };
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
    const [state, projects, sandboxes] = await Promise.all([
      readWorktreeCleanupState(process.env),
      listProjectRegistry(cfg),
      readSandboxRegistry(),
    ]);
    assertInventory();
    const roots = new Map<string, string[]>();
    const createdAtByRoot = new Map<string, number>();
    const rootsBySession = new Map<string, string[]>();
    // Registry rows are newest-first; a fresh prefix can consume every restarted pass.
    for (let index = state.records.length - 1; index >= 0; index--) {
      const record = state.records[index]!;
      if (record.removedAt === undefined) {
        const root = path.resolve(record.path);
        const ids = roots.get(root) ?? [];
        ids.push(record.id);
        roots.set(root, ids);
        createdAtByRoot.set(
          root,
          Math.min(createdAtByRoot.get(root) ?? Infinity, record.createdAt),
        );
        if (record.ownerKind === "session" && record.ownerId) {
          const owned = rootsBySession.get(record.ownerId) ?? [];
          owned.push(root);
          rootsBySession.set(record.ownerId, owned);
        }
      }
    }
    const otherRoots = [
      ...projects.map((project) => project.repoRoot),
      ...listAgentIds(cfg).flatMap((id) => [
        resolveAgentWorkspaceDir(cfg, id),
        resolveAgentRunCwd(cfg, id),
      ]),
    ];
    // Container retirement preserves workspace bytes but removes its registry row.
    // Keep their scratch discoverable under the configured workspace owner afterward.
    const sandboxRoots = new Set(
      listAgentIds(cfg).flatMap((id) => {
        const sandbox = resolveSandboxConfigForAgent(cfg, id);
        return ["docker", "podman"].includes(sandbox.backend) ? [sandbox.workspaceRoot] : [];
      }),
    );
    let hasSandboxWorkspaces = false;
    for (const root of sandboxRoots) {
      const directory = resolveUserPath(root);
      otherRoots.push(directory);
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      hasSandboxWorkspaces ||= entries.length > 0;
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== ".openclaw") {
          otherRoots.push(path.join(directory, entry.name));
        }
      }
    }
    const localSandboxes = new Map<string, typeof sandboxes.entries>();
    for (const sandbox of sandboxes.entries) {
      if (
        sandbox.workspaceDir &&
        (!sandbox.backendId || ["docker", "podman"].includes(sandbox.backendId))
      ) {
        const root = path.resolve(sandbox.workspaceDir);
        otherRoots.push(root);
        const entries = localSandboxes.get(root) ?? [];
        entries.push(sandbox);
        localSandboxes.set(root, entries);
      }
    }
    hasSandboxWorkspaces ||= localSandboxes.size > 0;
    for (const directory of otherRoots) {
      if (!directory) {
        continue;
      }
      const root = path.resolve(directory);
      if (!roots.has(root)) {
        roots.set(root, []);
        const stat = await fs.stat(root).catch(() => undefined);
        createdAtByRoot.set(root, stat && stat.birthtimeMs > 0 ? stat.birthtimeMs : Infinity);
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
      const current = currentLocalRunSessions(cfg);
      for (const placement of placements.placements) {
        if (placement.turnClaim) {
          current.keys.add(placement.sessionKey);
          current.needsBinding.add(placement.sessionKey);
        }
      }
      if (hasSandboxWorkspaces) {
        for (const key of current.keys) {
          current.needsBinding.add(key);
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
        for (const key of pathsByKey.keys()) {
          changedKeys.add(key);
        }
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
        if (hasSandboxWorkspaces) {
          const runtime = resolvePreparedSandboxRuntimeStatus({
            cfg,
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            preparedSessionEntry: entry ?? null,
          });
          const selected = await resolveSandboxSession({
            config: cfg,
            sessionKey: target.canonicalKey,
            preparedRuntimeStatus: runtime,
            skillsSnapshot: { librarySelections: entry?.skillLibrarySelections },
          });
          if (selected) {
            for (const workspaceDir of [...paths, ...(current.sourcePaths.get(key) ?? [])]) {
              paths.push(
                resolveSandboxWorkspaceLayoutPaths({
                  cfg: selected.cfg,
                  rawSessionKey: selected.rawSessionKey,
                  agentId: target.agentId,
                  isolationSubject: selected.runtime.isolationSubject,
                  workspaceDir,
                }).workspaceDir,
              );
            }
          }
        }
        pathsByKey.set(key, paths);
        pathsByKey.set(target.canonicalKey, paths);
      }
      runsChanged = true;
    };
    await prepare();
    const liveScopes = new Set(state.leases.liveScopes);
    let liveRoots = new Set<string>();
    let unboundSince = Infinity;
    const isLive = (root: string, worktreeIds: readonly string[]) => {
      guards.get(root)!();
      placements.assertCurrent();
      // This pass consumes prepared custody facts until their owners publish a change.
      // Custody checks do not rescan every run or query session storage.
      if (runsChanged) {
        const currentRoots = new Set<string>();
        const current = runSessions();
        unboundSince = current.unboundSince;
        const paths = current.unboundPaths;
        let pending = false;
        for (const key of current.keys) {
          const binding = current.needsBinding.has(key) ? pathsByKey.get(key) : [];
          paths.push(...(binding ?? []), ...(current.sourcePaths.get(key) ?? []));
          if (current.needsBinding.has(key) && (!binding || allChanged || changedKeys.has(key))) {
            pending = true;
            // Churn retains this session's possible owners, not every unrelated checkout.
            const owned = rootsBySession.get(key) ?? [];
            paths.push(...owned);
            if (!binding?.length && !owned.length) {
              unboundSince = Math.min(unboundSince, current.startedAtByKey.get(key) ?? Infinity);
            }
            const agentId = parseAgentSessionKey(key)?.agentId;
            if (agentId) {
              paths.push(resolveAgentWorkspaceDir(cfg, agentId), resolveAgentRunCwd(cfg, agentId));
            }
          }
        }
        for (const runPath of paths) {
          if (!runPath) {
            continue;
          }
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
        liveRoots = currentRoots;
        runsChanged = pending;
      }
      return (
        (runsChanged && worktreeIds.length === 0) ||
        worktreeIds.some((id) => liveScopes.has(`worktree-run:${id}`)) ||
        liveRoots.has(root) ||
        (localSandboxes.get(root)?.some(hasActiveContainerUsage) ?? false) ||
        (unboundSince < Infinity && createdAtByRoot.get(root)! >= unboundSince)
      );
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
