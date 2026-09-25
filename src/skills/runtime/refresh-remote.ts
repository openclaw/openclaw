import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import type { WorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";

const log = createSubsystemLogger("gateway/skills");
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
type RemoteSkillsWatch = {
  access: AgentWorkspaceAccess;
  signature: string;
  controller: AbortController;
  unavailable: boolean;
};
const remoteWatchers = new Map<string, RemoteSkillsWatch>();
// Retired transports may still be draining; shutdown must await them too.
const remoteWatchTasks = new Set<Promise<void>>();

export function ensureRemoteSkillsWatcher(params: {
  watcherKey: string;
  workspaceDir: string;
  executionWorkspaceDir?: string;
  access: AgentWorkspaceAccess;
  sourcePlan: WorkspaceSkillSourcePlan;
}): void {
  const { watcherKey, workspaceDir, access } = params;
  const drainSignal = getGatewayRestartDrainSignal();
  if (drainSignal.aborted) {
    return;
  }
  const request = {
    sourcePlan: params.sourcePlan,
    executionWorkspaceDir: params.executionWorkspaceDir,
  };
  const signature = JSON.stringify(request);
  const previous = remoteWatchers.get(watcherKey);
  if (previous?.access === access && previous.signature === signature) {
    if (previous.unavailable) {
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "remote-node" });
    }
    return;
  }
  disposeRemoteSkillsWatcher(watcherKey);
  const state: RemoteSkillsWatch = {
    access,
    signature,
    controller: new AbortController(),
    unavailable: !access.watchSkills,
  };
  remoteWatchers.set(watcherKey, state);
  // Acquisition closes the unwatched cache interval before any consumer can reuse a snapshot.
  bumpSkillsSnapshotVersion({ workspaceDir, reason: "remote-node" });
  const watch = access.watchSkills;
  if (!watch) {
    return;
  }
  // The remote subscription owns a node invocation. Retire it when drain begins,
  // before shutdown waits for invocations to settle and eventually closes watchers.
  const signal = AbortSignal.any([state.controller.signal, drainSignal]);
  const isCurrent = () => remoteWatchers.get(watcherKey) === state && !signal.aborted;
  const task = runInSkillsWatcherContext(async () => {
    try {
      await watch(
        request,
        (event) => {
          if (!isCurrent()) {
            return;
          }
          if (event === "unavailable") {
            state.unavailable = true;
          } else if (event === "available") {
            // Recovery has already reconciled outage edits through change events.
            // Coverage alone restores reuse without inventing a content revision.
            state.unavailable = false;
            return;
          }
          bumpSkillsSnapshotVersion({
            workspaceDir,
            reason: "remote-node",
          });
        },
        signal,
      );
    } catch (error) {
      if (isCurrent()) {
        log.warn(`remote skills watcher stopped (${workspaceDir}): ${String(error)}`);
      }
    } finally {
      if (remoteWatchers.get(watcherKey) === state) {
        remoteWatchers.delete(watcherKey);
        if (!signal.aborted) {
          bumpSkillsSnapshotVersion({ workspaceDir, reason: "remote-node" });
        }
      }
    }
  });
  remoteWatchTasks.add(task);
  void task.finally(() => remoteWatchTasks.delete(task));
}

export function disposeRemoteSkillsWatcher(watcherKey: string): boolean {
  const state = remoteWatchers.get(watcherKey);
  remoteWatchers.delete(watcherKey);
  state?.controller.abort();
  return Boolean(state);
}

export async function closeRemoteSkillsWatchers(): Promise<void> {
  for (const key of remoteWatchers.keys()) {
    disposeRemoteSkillsWatcher(key);
  }
  await Promise.all(remoteWatchTasks);
}
