import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import type { WorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";

const log = createSubsystemLogger("gateway/skills");
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const MAX_REMOTE_WATCHERS = 128;
type RemoteSkillsWatch = {
  access: AgentWorkspaceAccess;
  agentIds: Set<string>;
  unowned: boolean;
  signature: string;
  controller: AbortController;
  unavailable: boolean;
  task?: Promise<void>;
};
const remoteWatchers = new Map<string, RemoteSkillsWatch>();
let registryUpdate = Promise.resolve();

function updateRegistry(update: () => Promise<void>): Promise<void> {
  // A failed mutation reaches its caller without preventing later teardown.
  registryUpdate = registryUpdate.then(update, update);
  return registryUpdate;
}

async function retireWatcher(watcherKey: string): Promise<void> {
  const state = remoteWatchers.get(watcherKey);
  remoteWatchers.delete(watcherKey);
  state?.controller.abort();
  await state?.task;
}

export function ensureRemoteSkillsWatcher(params: {
  watcherKey: string;
  workspaceDir: string;
  agentId?: string;
  executionWorkspaceDir?: string;
  access: AgentWorkspaceAccess;
  sourcePlan: WorkspaceSkillSourcePlan;
}): Promise<void> {
  return updateRegistry(async () => {
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
      if (params.agentId) {
        previous.agentIds.add(params.agentId);
      } else {
        previous.unowned = true;
      }
      remoteWatchers.delete(watcherKey);
      remoteWatchers.set(watcherKey, previous);
      if (previous.unavailable) {
        bumpSkillsSnapshotVersion({ workspaceDir, reason: "remote-node" });
      }
      return;
    }
    await retireWatcher(watcherKey);
    if (remoteWatchers.size >= MAX_REMOTE_WATCHERS) {
      await retireWatcher(remoteWatchers.keys().next().value!);
    }
    if (drainSignal.aborted) {
      return;
    }
    const state: RemoteSkillsWatch = {
      access,
      agentIds: new Set(params.agentId ? [params.agentId] : []),
      unowned: params.agentId === undefined,
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
    state.task = runInSkillsWatcherContext(async () => {
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
  });
}

export function disposeRemoteSkillsWatcher(watcherKey: string): Promise<void> {
  return updateRegistry(() => retireWatcher(watcherKey));
}

export function closeRemoteSkillsWatchersForAgent(params: { agentId: string }): Promise<void> {
  return updateRegistry(async () => {
    const keys = [...remoteWatchers]
      .filter(([, state]) => {
        if (!state.agentIds.delete(params.agentId)) {
          return false;
        }
        return state.agentIds.size === 0 && !state.unowned;
      })
      .map(([key]) => key);
    await Promise.all(keys.map(retireWatcher));
  });
}

export function closeRemoteSkillsWatchers(): Promise<void> {
  return updateRegistry(async () => {
    const results = await Promise.allSettled([...remoteWatchers.keys()].map(retireWatcher));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Remote skills watcher shutdown failed");
    }
  });
}
