import { isDeepStrictEqual } from "node:util";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { prepareSessionFileWorkspace } from "../session-file-workspace.js";
import {
  SessionMutationAuthorizationChangedError,
  sessionMutationForbiddenError,
} from "../session-mutation-authorization-error.js";
import {
  authorizeSessionAgentRun,
  hasSessionReadAccessChanged,
  isSessionOwnRequester,
} from "../session-sharing-policy.js";
import type { GatewaySessionEntryRead } from "../session-utils-store.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
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
    throw sessionMutationForbiddenError(
      "Only this conversation's owner can open its files from before the PR workspace.",
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
    "inheritedWorktreeId",
  ] as const;
  return (
    fields.every((field) => isDeepStrictEqual(previous?.[field], current?.[field])) &&
    ((!previous?.inheritedWorktreeId && !current?.inheritedWorktreeId) ||
      (previous?.spawnedBy === current?.spawnedBy &&
        previous?.spawnedBySessionId === current?.spawnedBySessionId &&
        previous?.parentSessionLifecycleRevision === current?.parentSessionLifecycleRevision)) &&
    previous?.worktree?.id === current?.worktree?.id &&
    isDeepStrictEqual(previous?.priorWorkspace, current?.priorWorkspace) &&
    isDeepStrictEqual(
      previous?.skillsSnapshot?.librarySelections,
      current?.skillsSnapshot?.librarySelections,
    )
  );
}

/** Runtime lineage identifies the source; the actual viewer must independently see each owner. */
export async function retainSessionFileSourceReads(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  workspace: Awaited<ReturnType<typeof prepareSessionFileWorkspace>> | undefined,
  mutation = false,
) {
  const lifetime = new DisposableStack();
  const reads: Array<NonNullable<Awaited<ReturnType<typeof retainSessionScopedRead>>>> = [];
  const mutations: Array<
    NonNullable<GatewayRequestHandlerOptions["sessionMutationAuthorization"]>
  > = [];
  const assertCurrent = () => {
    for (const authorization of mutations) {
      authorization.assertCurrent();
    }
    for (const read of reads) {
      read.assertCurrent();
      assertSessionFileReadPolicy(options, {
        agentId,
        canonicalKey: read.prepared.canonicalKey,
        entry: read.prepared.readRetainedEntry(),
        unscopedHostRoot: true,
      });
    }
  };
  try {
    for (const sessionKey of workspace?.sourceSessionKeys ?? []) {
      const read = await retainSessionScopedRead(options, sessionKey, agentId, {
        requireMaterialized: true,
        retain: true,
        entryMatches: (previous, current) =>
          !hasSessionReadAccessChanged(previous, current) &&
          sessionFileWorkspaceMatches(previous, current),
      });
      if (read) {
        lifetime.defer(read.release);
        reads.push(read);
      }
      if (mutation) {
        const { resolveSessionMutationAuthorizationAsync } =
          await import("../session-sharing-authorization-async.js");
        const { authorization, error } = await resolveSessionMutationAuthorizationAsync({
          client: options.client,
          context: options.context,
          method: "sessions.files.set",
          requestParams: { sessionKey, agentId },
          sessionScope: readGatewayRequestMutationAuthority(options).sessionScope,
          assertInvocationCurrent: () =>
            readGatewayRequestMutationAuthority(options).assertCurrent(),
        });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
        if (authorization) {
          lifetime.defer(() => authorization.release?.());
          mutations.push(authorization);
        }
      }
      assertCurrent();
    }
    return { assertCurrent, [Symbol.dispose]: () => lifetime.dispose() };
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}

/** Host reads borrow the turn owner's prepared facts and the placement owner's live observation. */
export async function createSessionFileReadAuthority(
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
  const sourceReads = await retainSessionFileSourceReads(options, agentId, source.fileWorkspace);
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
      throw sessionMutationForbiddenError("outside session boundary");
    }
  };
  const withHostAuthority = async <T>(consume: () => T): Promise<T> => {
    if (!options.withSessionTurnAuthority || !source.entry?.sessionId) {
      throw sessionMutationForbiddenError("outside session boundary");
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
      sourceReads.assertCurrent();
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
        throw sessionMutationForbiddenError("Session workspace changed during file access");
      }
      if (usedHostRead && source.entry) {
        assertHostEntry(source.entry);
      }
    },
    hasHostRead: () => usedHostRead,
    release: () => {
      sourceReads[Symbol.dispose]();
      placement?.release();
    },
  };
}
