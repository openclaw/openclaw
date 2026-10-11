import { notifyListeners, registerListener } from "../shared/listeners.js";

const retirementObservers = new Set<(profileIds: readonly string[]) => void>();

export function observeUserGitHubProfileRetirement(
  observer: (profileIds: readonly string[]) => void,
): () => void {
  return registerListener(retirementObservers, observer);
}

export function publishUserGitHubProfileRetirement(ids: readonly string[]): void {
  if (ids.length > 0) {
    notifyListeners(retirementObservers, ids);
  }
}
