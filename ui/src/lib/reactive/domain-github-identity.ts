import { action, createOptimistic, onSettled } from "solid-js";
import { createGitHubIdentity } from "../../features/github-connections/github-identity.ts";
import { projectOwner } from "./projection.ts";

/** Admission remains synchronous in the owner; only presentation joins its completion. */
export function createGitHubIdentityView(deps: Parameters<typeof createGitHubIdentity>[0] = {}) {
  const owner = createGitHubIdentity(deps);
  const projection = projectOwner(owner, (source) => source.read());
  const [saving, setSaving] = createOptimistic(false, { equals: false });
  const showSaving = action(function* (completion: Promise<void>) {
    setSaving(true);
    yield completion;
  });
  onSettled(() => {
    let previous: Promise<void> | undefined;
    const observe = () => {
      const completion = owner.read().mutationCompletion;
      if (completion && completion !== previous) {
        // Commit the owner's busy publication before the action holds its frame.
        void Promise.resolve()
          .then(() => {
            if (owner.read().mutationCompletion === completion) {
              return showSaving(completion);
            }
            return undefined;
          })
          // The native error boundary consumes this same admitted result.
          .catch(() => {});
      }
      previous = completion;
    };
    const stop = owner.subscribe(observe);
    observe();
    return () => {
      stop();
      owner.dispose();
    };
  });
  return { ...owner, read: projection.read, saving };
}

export type GitHubIdentityView = ReturnType<typeof createGitHubIdentityView>;
