import { closeRemoteSkillsWatchersForAgent, disposeRemoteSkillsWatcher } from "./refresh-remote.js";
import {
  unsubscribeWorkspaceFromPath,
  workspaceWatchLastEnsuredAt,
  workspaceWatchOwners,
  workspaceWatchTargetCache,
  workspaceWatchTargets,
  type SkillsWatchOwner,
} from "./refresh-watch-registry.js";
import type { WatchTarget } from "./refresh-watch-targets.js";

const retiringWatchersByOwner = new Map<SkillsWatchOwner, Set<Promise<void>>>();

export function unsubscribeOwnedWorkspaceFromPath(
  watcherKey: string,
  watchTarget: WatchTarget,
): Promise<void> | undefined {
  const owner = workspaceWatchOwners.get(watcherKey);
  const closing = unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
  if (!owner || !closing) {
    return closing;
  }
  const retirements = retiringWatchersByOwner.get(owner) ?? new Set<Promise<void>>();
  if (!retirements.has(closing)) {
    retirements.add(closing);
    retiringWatchersByOwner.set(owner, retirements);
    void closing.then(
      () => {
        retirements.delete(closing);
        if (retirements.size === 0 && retiringWatchersByOwner.get(owner) === retirements) {
          retiringWatchersByOwner.delete(owner);
        }
      },
      () => {},
    );
  }
  return closing;
}

export function disposeWorkspaceWatchState(
  watcherKey: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(watcherKey) ?? [],
): Promise<void>[] {
  disposeRemoteSkillsWatcher(watcherKey);
  const closing: Promise<void>[] = [];
  for (const watchTarget of watchTargets) {
    const retired = unsubscribeOwnedWorkspaceFromPath(watcherKey, watchTarget);
    if (retired) {
      closing.push(retired);
    }
  }
  workspaceWatchTargets.delete(watcherKey);
  workspaceWatchOwners.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  // Reacquisition invalidates after an unwatched interval. Disposal itself does
  // not change skills, including for other subscriptions sharing this workspace.
  return closing;
}

export async function closeSkillsWatchersForAgent(params: { agentId: string }): Promise<void> {
  // A moved workspace can leave old subscriptions behind; the agent ID owns them all.
  const matchesOwner = (owner: SkillsWatchOwner) => owner.agentId === params.agentId;
  const closing = new Set<Promise<void>>();
  for (const [watcherKey, owner] of workspaceWatchOwners) {
    if (matchesOwner(owner)) {
      for (const retirement of disposeWorkspaceWatchState(watcherKey)) {
        closing.add(retirement);
      }
    }
  }
  for (const [owner, retirements] of retiringWatchersByOwner) {
    if (matchesOwner(owner)) {
      for (const retirement of retirements) {
        closing.add(retirement);
      }
    }
  }
  const results = await Promise.allSettled([...closing, closeRemoteSkillsWatchersForAgent(params)]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Skills watcher retirement failed; restart the Gateway, preview removal, and retry.",
    );
  }
  if ([...workspaceWatchOwners.values()].some(matchesOwner)) {
    throw new Error(
      "Claw skills watcher was reacquired during drainage; preview and retry removal.",
    );
  }
}
