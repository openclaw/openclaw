import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { prepareSessionFileWorkspace } from "../session-file-workspace.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { authorizeSessionAgentRun, isSessionOwnRequester } from "../session-sharing-policy.js";
import type { GatewaySessionEntryRead } from "../session-utils-store.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { resolveFileRoot } from "./workspace-files.js";

export type SessionFileReadPolicyTarget = {
  agentId: string;
  canonicalKey: string;
  entry?: InternalSessionEntry;
  unscopedHostRoot?: boolean;
  /** The read serves files from before the conversation switched to its PR workspace. */
  historical?: boolean;
};

/** Conversation visibility does not admit a caller to an unsandboxed host workspace. */
export function assertSessionFileReadPolicy(
  options: GatewayRequestHandlerOptions,
  target: SessionFileReadPolicyTarget,
) {
  // Shared viewing, membership and admin scope never extend to the original files.
  if (
    target.historical &&
    !(
      target.entry &&
      isSessionOwnRequester(
        { cfg: options.context.getRuntimeConfig(), client: options.client },
        { canonicalKey: target.canonicalKey, entry: target.entry },
      )
    )
  ) {
    throw new SessionMutationAuthorizationChangedError(
      errorShape(
        ErrorCodes.FORBIDDEN,
        "Only this conversation's owner can open its files from before the PR workspace.",
      ),
    );
  }
  if (!target.unscopedHostRoot) {
    return;
  }
  readGatewayRequestMutationAuthority(options).assertCurrent();
  const error = authorizeSessionAgentRun({
    cfg: options.context.getRuntimeConfig(),
    client: options.client,
    target: { agentId: target.agentId, canonicalKey: target.canonicalKey, entry: target.entry },
  });
  if (error) {
    throw new SessionMutationAuthorizationChangedError(error);
  }
}

/** Workspace authority excludes routine title, usage and activity metadata. */
export function sessionFileWorkspaceMatches(
  previous: InternalSessionEntry | undefined,
  current: InternalSessionEntry | undefined,
): boolean {
  const fields = [
    "sessionId",
    "lifecycleRevision",
    "archivedAt",
    "repositoryWorkspaceId",
    "deviceFolder",
    "sessionRoot",
    "spawnedCwd",
    "spawnedWorkspaceDir",
    "pendingWorktree",
    "pendingProjectGitUrl",
    "execNode",
    "permissionMode",
    "sandbox",
    "sandboxMode",
    "createdActor",
  ] as const;
  return (
    fields.every((field) => isDeepStrictEqual(previous?.[field], current?.[field])) &&
    previous?.worktree?.id === current?.worktree?.id &&
    isDeepStrictEqual(previous?.priorWorkspace, current?.priorWorkspace) &&
    isDeepStrictEqual(
      previous?.skillsSnapshot?.librarySelections,
      current?.skillsSnapshot?.librarySelections,
    )
  );
}

/** Host reads borrow the turn owner's prepared facts and the placement owner's live observation. */
export function createSessionFileReadAuthority(
  options: GatewayRequestHandlerOptions,
  source: Pick<GatewaySessionEntryRead, "agentId" | "canonicalKey" | "storePath" | "readSource"> & {
    entry?: InternalSessionEntry;
    readEntry: () => InternalSessionEntry | undefined;
    assertSourceCurrent: () => void;
    root?: string;
    fileRoot?: string;
    fileWorkspace?: Awaited<ReturnType<typeof prepareSessionFileWorkspace>>;
  },
) {
  const { context } = options;
  const { agentId } = source;
  let placement:
    | Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>
    | undefined;
  let usedHostRead = false;
  const assertHostEntry = (entry: InternalSessionEntry) => {
    placement?.assertCurrent();
    const current = resolveSessionWorkspaceRoots(context.getRuntimeConfig(), agentId, entry, {
      sessionKey: source.canonicalKey,
      fileToolsOnGatewayHost: Boolean(
        placement &&
        !placement.move &&
        !placement.pendingResult &&
        (!placement.placement ||
          placement.placement.state === "local" ||
          placement.placement.state === "reclaimed") &&
        !entry.execNode &&
        source.root &&
        !getAgentWorkspaceAccess(source.root),
      ),
    });
    if (
      current.readScope !== "host" ||
      current.root !== source.root ||
      resolveFileRoot(current) !== source.fileRoot
    ) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.FORBIDDEN, "outside session boundary"),
      );
    }
  };
  const withHostAuthority = async <T>(consume: () => T): Promise<T> => {
    if (!options.withSessionTurnAuthority || !source.entry?.sessionId) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.FORBIDDEN, "outside session boundary"),
      );
    }
    return options.withSessionTurnAuthority(
      { sessionKey: source.canonicalKey, agentId, sessionId: source.entry.sessionId },
      (entry) => {
        assertHostEntry(entry);
        return consume();
      },
    );
  };
  let hostAdmission: Promise<boolean> | undefined;
  const prepareHostRead = async (): Promise<boolean> => {
    try {
      if (!placement && source.entry?.sessionId) {
        placement = await context.workerSessionPlacementService?.prepareRuntimeRefresh?.(
          source.entry.sessionId,
        );
      }
      return await withHostAuthority(() => {
        usedHostRead = true;
        return true;
      });
    } catch (error) {
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      return false;
    }
  };
  return {
    authorizeHostRead: () =>
      source.fileWorkspace?.historical
        ? Promise.resolve(false)
        : (hostAdmission ??= prepareHostRead()),
    withCurrent: withHostAuthority,
    // Downloads retain the exact session row separately; recheck host configuration
    // and the placement owner's current observation immediately before HTTP delivery.
    assertCurrent: () => {
      source.assertSourceCurrent();
      const current = source.readEntry();
      if (current && source.fileWorkspace) {
        source.fileWorkspace.assertCurrent(context.getRuntimeConfig(), current);
        assertSessionFileReadPolicy(options, {
          ...source,
          entry: current,
          unscopedHostRoot: source.fileWorkspace.unscopedHostRoot,
          historical: source.fileWorkspace.historical,
        });
      }
      if (
        !source.fileWorkspace &&
        source.entry &&
        !source.entry.repositoryWorkspaceId &&
        resolveSessionWorkspaceRoots(context.getRuntimeConfig(), agentId, source.entry).root !==
          source.root
      ) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.FORBIDDEN, "Session workspace changed during file access"),
        );
      }
      if (usedHostRead && source.entry) {
        assertHostEntry(source.entry);
      }
    },
    hasHostRead: () => usedHostRead,
    release: () => placement?.release(),
  };
}
