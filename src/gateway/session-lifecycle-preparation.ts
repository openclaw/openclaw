import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

export type GatewaySessionTitleModelSelection = Pick<
  SessionEntry,
  "agentRuntimeOverride" | "authProfileOverride" | "modelOverride" | "providerOverride"
>;

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<SessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  pendingWorktree?: SessionEntry["pendingWorktree"];
  /** Reacquire source custody only around the final persistence operation. */
  withCommit?: <T>(run: (assertSourceCurrent: () => void) => Promise<T>) => Promise<T>;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: SessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
  projectId?: string;
  /** Inherited or existing policy, resolved while the creation owner holds lifecycle custody. */
  sandboxRequired?: boolean;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

/** Bind prepared workspace facts and consume setup intent only after successful preparation. */
export function projectPreparedSessionWorkspace(
  existingEntry: SessionEntry | undefined,
  params: {
    projectId?: string;
    pendingProjectGitUrl?: string;
    pendingWorktree?: SessionEntry["pendingWorktree"];
    spawnedCwd?: string;
    preparedLifecycle?: PreparedGatewaySessionLifecycle;
  },
): Partial<SessionEntry> {
  const { projectId, pendingProjectGitUrl, pendingWorktree, spawnedCwd, preparedLifecycle } =
    params;
  const createdNewEntry = existingEntry === undefined;
  const recovered =
    preparedLifecycle?.worktree &&
    (existingEntry?.pendingWorktree || existingEntry?.pendingProjectGitUrl);
  return {
    ...(createdNewEntry && projectId ? { projectId } : {}),
    ...(createdNewEntry && pendingProjectGitUrl ? { pendingProjectGitUrl } : {}),
    ...(createdNewEntry && pendingWorktree ? { pendingWorktree } : {}),
    // Creation owns cwd adoption; public patching does not grant this authority.
    ...(spawnedCwd ? { spawnedCwd } : {}),
    ...(preparedLifecycle?.worktree ? { worktree: preparedLifecycle.worktree } : {}),
    ...(preparedLifecycle?.repositoryWorkspaceId
      ? { repositoryWorkspaceId: preparedLifecycle.repositoryWorkspaceId }
      : {}),
    ...(recovered
      ? { projectId, pendingWorktree: undefined, pendingProjectGitUrl: undefined }
      : {}),
  };
}

/** Join recorded commit actions even when the enclosing source scope fails during cleanup. */
export async function settleGatewaySessionLifecycleCommit<T>(
  commit: Promise<T>,
  afterCommit: readonly (() => void | Promise<void>)[],
): Promise<T> {
  const result: Result<T, unknown> = await commit.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  const failures: unknown[] = result.ok ? [] : [result.error];
  for (const action of afterCommit) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session reset commit and post-commit actions failed", {
      cause: failures.at(-1),
    });
  }
  if (!result.ok) {
    throw result.error;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  return result.value;
}

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}
