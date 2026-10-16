import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { resolveFileRoot } from "./workspace-files.js";

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
  ] as const;
  return (
    fields.every((field) => isDeepStrictEqual(previous?.[field], current?.[field])) &&
    previous?.worktree?.id === current?.worktree?.id
  );
}

/** Host reads borrow the turn owner's prepared facts and the placement owner's live observation. */
export function createSessionFileReadAuthority(
  options: GatewayRequestHandlerOptions,
  source: {
    agentId: string;
    canonicalKey: string;
    entry?: InternalSessionEntry;
    root?: string;
    fileRoot?: string;
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
    authorizeHostRead: () => (hostAdmission ??= prepareHostRead()),
    withCurrent: withHostAuthority,
    // Downloads retain the exact session row separately; recheck host configuration
    // and the placement owner's current observation immediately before HTTP delivery.
    assertCurrent: () => {
      if (
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
