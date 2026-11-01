import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { SessionEntryReadScope } from "../../config/sessions/session-accessor.types.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { prepareSessionFileWorkspace } from "../session-file-workspace.js";
import { SessionFileWorkspaceChangedError } from "../session-mutation-authorization-error.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "../session-transcript-read-target.js";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import type { GatewaySessionEntryRead } from "../session-utils-store.js";
import { sessionFileWorkspaceMatches } from "./session-file-read-authority.js";
import { prepareSessionFileReadPath } from "./session-file-read.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { loadSessionTouchedFiles } from "./session-touched-files.js";
import type { GatewayRequestContext } from "./types.js";
import { resolveFileRoot, type LoadedSessionFiles } from "./workspace-files.js";

async function loadSessionFileRoot(loaded: GatewaySessionEntryRead, messageEntryId?: string) {
  if (!loaded.entry?.sessionId || loaded.entry.repositoryWorkspaceId) {
    // Repository identity comes from the session owner; its files have no Gateway root.
    const rootless = {
      source: loaded.entry?.repositoryWorkspaceId
        ? { workspaceId: loaded.entry.repositoryWorkspaceId, root: null, fileRoot: null }
        : undefined,
      root: undefined,
      fileRoot: undefined,
      diffCwd: undefined,
      fileWorkspace: undefined,
    };
    return loaded.entry?.sessionId
      ? { ...loaded, ...rootless }
      : { ...loaded, ...rootless, agentId: undefined };
  }
  const fileWorkspace = await prepareSessionFileWorkspace(
    loaded.cfg,
    loaded.agentId,
    loaded.canonicalKey,
    loaded.entry,
    messageEntryId ? { entryId: messageEntryId, storePath: loaded.storePath } : undefined,
  );
  const { spawnedCwd, root, diffCwd } = fileWorkspace;
  const fileRoot = resolveFileRoot({ root, spawnedCwd });
  const source =
    !fileWorkspace.historical && loaded.entry.worktree?.id
      ? { workspaceId: loaded.entry.worktree.id, root: root ?? null, fileRoot: fileRoot ?? null }
      : undefined;
  return {
    ...loaded,
    fileWorkspace,
    root,
    fileRoot,
    source,
    diffCwd,
  };
}

/**
 * Reuse file-route workspace precedence, excluding remote-owned roots.
 * Exec-node sessions can otherwise fall back to a local agent directory.
 */
export async function prepareLocalSessionWorkspaceRoot(params: {
  sessionKey: string;
  agentId?: string;
  source: { entry: Partial<InternalSessionEntry> | undefined; cfg: OpenClawConfig };
}) {
  const { entry, cfg } = params.source;
  if (!entry?.sessionId || entry.repositoryWorkspaceId || entry.execNode) {
    return undefined;
  }
  const workspace = await prepareSessionFileWorkspace(
    cfg,
    params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    params.sessionKey,
    entry,
  );
  return workspace.root && !getAgentWorkspaceAccess(workspace.root) ? workspace : undefined;
}

/** Retain workspace authority independently of the evictable planning-row cache. */
export async function withSessionFileRoot<T>(
  params: {
    sessionKey: string;
    agentId?: string;
    projection?: SessionEntryReadScope["projection"];
    getRuntimeConfig?: () => OpenClawConfig;
    messageEntryId?: string;
    retained?: Awaited<ReturnType<typeof retainGatewaySessionEntryReadOnly>>;
  },
  cfg: OpenClawConfig,
  consume: (
    loaded: Awaited<ReturnType<typeof loadSessionFileRoot>>,
    assertCurrent: () => void,
    readEntry: () => InternalSessionEntry | undefined,
  ) => Promise<T>,
): Promise<T> {
  const session =
    params.retained ??
    (await retainGatewaySessionEntryReadOnly(
      params.sessionKey,
      params.agentId,
      sessionFileWorkspaceMatches,
      cfg,
      {
        projection:
          params.projection && params.projection !== "full"
            ? [...(params.projection === "list" ? [] : params.projection), "skillsSnapshot"]
            : "full",
      },
    ));
  try {
    const loaded = await loadSessionFileRoot(session, params.messageEntryId);
    const assertCurrent = () => {
      if (!session.isCurrentAtResponse()) {
        throw new SessionFileWorkspaceChangedError();
      }
      const current = session.readRetainedEntry();
      if (current) {
        loaded.fileWorkspace?.assertCurrent(params.getRuntimeConfig?.() ?? cfg, current);
      }
    };
    assertCurrent();
    const result = await consume(loaded, assertCurrent, session.readRetainedEntry);
    assertCurrent();
    return result;
  } finally {
    if (!params.retained) {
      session.release();
    }
  }
}

export async function loadSessionFiles(
  loaded: Awaited<ReturnType<typeof loadSessionFileRoot>>,
  context: GatewayRequestContext,
  assertSourceCurrent: () => void,
  assertReaderCurrent: () => void,
  filePath?: string,
): Promise<
  LoadedSessionFiles & {
    repository?: Awaited<ReturnType<typeof resolveRepositoryWorkspaceAccess>>;
    readPath?: Awaited<ReturnType<typeof prepareSessionFileReadPath>>;
  }
> {
  const { storePath, entry, canonicalKey, agentId } = loaded;
  if (!entry?.sessionId || !storePath || !agentId) {
    return { files: [] };
  }
  const preparedPath = await prepareSessionFileReadPath({
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    filePath,
    sandboxWorkspace: loaded.fileWorkspace?.sandboxWorkspace,
    historical: loaded.fileWorkspace?.historical,
    worktreeId: entry.worktree?.id,
    assertCurrent: assertSourceCurrent,
    assertReadCurrent: assertReaderCurrent,
  });
  if (preparedPath.path === null) {
    return { files: [], readPath: preparedPath };
  }
  const scope = {
    agentId,
    sessionEntry: entry,
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    storePath,
  } satisfies SessionTranscriptReadScope;
  const target = await resolveTranscriptReadTarget(scope);
  // Entry-scoped reads without an explicit sessionFile always resolve to a canonical SQLite marker.
  // Legacy transcript files are doctor-owned migration debt, not a runtime read path.
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent: assertSourceCurrent,
    authorize() {},
  });
  const sourceIdentity = memory?.owner?.identity.incarnation;
  const files = await loadSessionTouchedFiles(
    toTranscriptReadScope(target),
    `${agentId}\0${entry.sessionId}\0${target.storePath ?? ""}${sourceIdentity ? `\0${sourceIdentity}` : ""}`,
  );
  return {
    repository: await resolveRepositoryWorkspaceAccess(loaded, context, assertSourceCurrent),
    readPath: preparedPath,
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    diffCwd: loaded.diffCwd,
    // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a fresh, private array.
    files: [...files.values()].sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "modified" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    }),
  };
}
