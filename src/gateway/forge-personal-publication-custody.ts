import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import {
  readGitHubPublicationWorktreeOwner,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import {
  bindGitHubPublicationSourceLifetime,
  type GitHubPublicationSourceCapability,
} from "./github-publication-source.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

/** Host-prepared requester facts; the provider never mints a session source. */
export type PersonalForgePublicationActionV2 = PublicationSessionIdentity & {
  owner: string;
  lifecycleRevision: string | null;
  version: 2;
  signal: AbortSignal;
  assertCurrent(): void;
  prepareSource(
    selector: GitHubPublicationSourceSelector,
  ): Promise<GitHubPublicationSourceCapability>;
};

export type PersonalForgePublicationWorkspace = {
  assertCurrent(): void;
  assertCustody(): void;
  worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"];
};

export async function preparePersonalForgePublicationSource(
  action: PersonalForgePublicationActionV2,
  selector: GitHubPublicationSourceSelector,
  assertRuntimeCurrent: () => void,
  runtimeSignal?: AbortSignal,
): Promise<GitHubPublicationSourceCapability> {
  action.assertCurrent();
  const source = await action.prepareSource(selector);
  try {
    assertRuntimeCurrent();
    action.assertCurrent();
    return runtimeSignal ? bindGitHubPublicationSourceLifetime(source, runtimeSignal) : source;
  } catch (error) {
    await source.release();
    throw error;
  }
}

/** One native placement, owner, and exclusive run lease hold the entire provider operation. */
export async function withPersonalForgePublicationWorkspace<T>(
  placements: Pick<WorkerSessionPlacementStore, "withLocalWorkspaceReservation">,
  action: PublicationSessionIdentity & { owner: string; assertCurrent(): void },
  run: (workspace: PersonalForgePublicationWorkspace) => Promise<T>,
): Promise<T> {
  action.assertCurrent();
  return await placements.withLocalWorkspaceReservation(action, async (assertReservation) => {
    const worktreeOwner = await readGitHubPublicationWorktreeOwner(action);
    using _ = { [Symbol.dispose]: () => worktreeOwner.release() };
    const { worktree } = worktreeOwner;
    action.assertCurrent();
    assertReservation();
    const lease = await acquireWorktreeRunLease(worktree.id, { exclusive: true });
    const assertCustody = () => {
      assertReservation();
      const current = worktreeOwner.assertCurrent();
      const workStartError = resolveSessionWorkStartError(action.sessionKey, current.loaded.entry, {
        expectedSessionId: action.sessionId,
      });
      if (workStartError) {
        throw new Error(workStartError);
      }
    };
    const assertCurrent = () => {
      action.assertCurrent();
      assertCustody();
    };
    try {
      assertCurrent();
      return await run({ assertCurrent, assertCustody, worktree });
    } finally {
      await lease.release();
    }
  });
}
