import path from "node:path";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { registerOpenClawAgentDatabaseSyncResource } from "../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
  RepositorySessionSourceScope,
  RepositoryTaskPublications,
} from "./repository-session-read.types.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

/** Retain source lifetime through the caller's last assertion and publication. */
export async function withControlUiSessionPrSource<T>(
  source: { agentId: string; path: string },
  operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
): Promise<T> {
  const target = { agentId: normalizeAgentId(source.agentId), path: path.resolve(source.path) };
  const selected = getSessionActorStorageBinding({
    agentId: target.agentId,
    storePath: target.path,
  });
  if (selected) {
    const assertCurrent = () => {
      selected.authority.assertCurrent();
      selected.actor.assertReadable();
    };
    return operation(assertCurrent, JSON.stringify(selected.actor.target.database));
  }
  const unregister: Array<() => void> = [];
  let active = true;
  const changed = () => new Error("Session PR source changed or closed. Retry the request.");
  try {
    if (isIncognitoOpenClawAgentSqlitePath(target.path, target)) {
      const assertActive = () => {
        if (!active) {
          throw changed();
        }
      };
      const captured = captureSessionActorStorageOwner(
        { agentId: target.agentId, storePath: target.path },
        { assertCurrent: assertActive, authorize: assertActive },
      );
      const owner = captured?.owner;
      if (!captured || !owner) {
        throw changed();
      }
      const assertCurrent = () => {
        captured.authority.assertCurrent();
        owner.assertCurrent();
      };
      assertCurrent();
      return await operation(assertCurrent, JSON.stringify(owner.identity));
    }
    const candidate = captureSessionStoreReadCandidate(target.path);
    const identity = readDatabasePathIdentitySync(candidate.path);
    if (!identity.key.startsWith("file:") || identity.canonicalPath !== candidate.physicalPath) {
      throw changed();
    }
    const sourceIdentity = identity.key;
    const paths = [...new Set([candidate.path, candidate.physicalPath])];
    // Both lexical and physical close paths retire this capture before another await can publish.
    for (const pathname of paths) {
      unregister.push(
        registerOpenClawAgentDatabaseSyncResource({
          agentId: target.agentId,
          path: pathname,
          revoke: () => {
            active = false;
          },
          close: () => {
            active = false;
          },
        }),
      );
    }
    // Each load captures physical identity; the owner revokes every later read synchronously.
    const assertCurrent = () => {
      if (!active) {
        throw changed();
      }
    };
    return await operation(assertCurrent, sourceIdentity);
  } finally {
    active = false;
    for (const release of unregister.toReversed()) {
      release();
    }
  }
}

type SelectedSession = {
  cfg: OpenClawConfig;
  agentId: string;
  canonicalKey: string;
  storePath: string;
  readSource?: { agentId: string; path: string };
  entry: MaterializedRow["entry"] | undefined;
};

/** This projection is data only: it cannot read, authorize, or retain an operation. */
export function observeSelectedRepositorySession(
  selected: SelectedSession,
  repository: MaterializedRow["materialized"]["row"]["repository"] | null,
): RepositorySessionObservation | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath || !readSource) {
    return undefined;
  }
  const session = Object.freeze({
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    agentId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
  });
  const root = entry.repositoryWorkspaceId
    ? undefined
    : resolveSessionWorkspaceRoots(cfg, agentId, entry).diffCwd;
  const source = entry.repositoryWorkspaceId
    ? repository
      ? Object.freeze({
          kind: "repository" as const,
          url: repository.url,
          branch: repository.branch,
        })
      : null
    : root
      ? Object.freeze({ kind: "checkout" as const, root })
      : null;
  const identity = JSON.stringify([
    agentId,
    canonicalKey,
    storePath,
    readSource.agentId,
    readSource.path,
    entry.sessionId,
    entry.lifecycleRevision,
    entry.repositoryWorkspaceId,
    entry.worktree?.id,
    source,
  ]);
  return Object.freeze({
    session,
    source,
    identity,
    branchIdentity: identity,
    ...(entry.worktree
      ? {
          worktree: Object.freeze({
            id: entry.worktree.id,
            repoRoot: entry.worktree.repoRoot,
            branch: entry.worktree.branch,
          }),
        }
      : {}),
    refreshIndex: Boolean(entry.worktree && !entry.repositoryWorkspaceId),
  });
}

/** Physical custody and live selection are required separately; neither is reconstructed from data. */
export function prepareSelectedRepositorySessionRead(
  selected: SelectedSession,
  repository: MaterializedRow["materialized"]["row"]["repository"] | null,
  owner: {
    assertCurrent: () => void;
    runSource: <T>(run: () => Promise<T>) => Promise<T>;
  },
): PreparedRepositorySessionRead | undefined {
  owner.assertCurrent();
  const observed = observeSelectedRepositorySession(selected, repository);
  const readSource = selected.readSource;
  if (!observed || !readSource) {
    return undefined;
  }
  const { assertCurrent, runSource } = owner;
  const { source } = observed;
  return Object.freeze({
    ...observed,
    includesTaskPublications: false,
    assertCurrent,
    async withSource<T>(
      operation: (scope: RepositorySessionSourceScope) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      return await runSource(() =>
        withControlUiSessionPrSource(readSource, async (assertPhysicalCurrent, identity) => {
          let active = true;
          const assertSourceCurrent = () => {
            if (!active) {
              throw new Error("Session PR source changed or closed. Retry the request.");
            }
            assertCurrent();
            assertPhysicalCurrent();
          };
          const scope: RepositorySessionSourceScope = {
            identity,
            assertCurrent: assertSourceCurrent,
            async readCheckoutRevision(input) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return null;
              }
              const result = await runGitReadOperation({
                type: "checkout.revision",
                input: { ...input, root: source.root },
              });
              assertSourceCurrent();
              return result?.key ?? null;
            },
            async readCheckoutBranchFacts(input, refresh = false) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return undefined;
              }
              const result = await runGitReadOperation(
                {
                  type: "pull-request.branch-facts",
                  input: { ...input, root: source.root, refreshIndex: observed.refreshIndex },
                },
                { refresh },
              );
              assertSourceCurrent();
              return result;
            },
            async readCheckoutFacts(refresh = false) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return undefined;
              }
              const result = await runGitReadOperation(
                { type: "checkout.context", input: { root: source.root } },
                { refresh },
              );
              assertSourceCurrent();
              return result ?? undefined;
            },
          };
          try {
            assertSourceCurrent();
            const result = await operation(scope);
            assertSourceCurrent();
            return result;
          } finally {
            active = false;
          }
        }),
      );
    },
    async readTaskPublications() {
      assertCurrent();
      return { receipts: [], count: 0, branchMatchCount: 0 };
    },
  });
}

/** Existing synchronous presentation callers receive observations, never unguarded read handles. */
export function observeProjectedRepositorySession(cfg: OpenClawConfig, record: MaterializedRow) {
  const { storePath, agentId } = record.storeTarget;
  return observeSelectedRepositorySession(
    {
      cfg,
      agentId: record.agentId,
      canonicalKey: record.key,
      storePath,
      readSource: { agentId, path: storePath },
      entry: record.entry,
    },
    record.materialized.row.repository ?? null,
  );
}

/** Guards stay in private closures; public observations cannot acquire their authority. */
export function guardRepositorySessionRead(
  target: PreparedRepositorySessionRead,
  options: {
    assertCurrent: () => void;
    identity?: string;
    taskAudienceKey?: string;
    readTaskPublications?: (
      input: { branchUrls?: readonly string[] },
      signal?: AbortSignal,
    ) => Promise<RepositoryTaskPublications>;
  },
): PreparedRepositorySessionRead {
  const assertCurrent = () => {
    target.assertCurrent();
    options.assertCurrent();
  };
  const readTask = options.readTaskPublications ?? target.readTaskPublications;
  return Object.freeze({
    ...target,
    identity: options.identity ?? target.identity,
    taskAudienceKey: options.taskAudienceKey ?? target.taskAudienceKey,
    includesTaskPublications:
      Boolean(options.readTaskPublications) || target.includesTaskPublications,
    assertCurrent,
    async withSource<T>(
      operation: (scope: RepositorySessionSourceScope) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      return await target.withSource(async (source) => {
        const assertSource = () => {
          assertCurrent();
          source.assertCurrent();
        };
        assertSource();
        const result = await operation({
          identity: source.identity,
          assertCurrent: assertSource,
          async readCheckoutFacts(refresh) {
            assertSource();
            const facts = await source.readCheckoutFacts(refresh);
            assertSource();
            return facts;
          },
          async readCheckoutRevision(input) {
            assertSource();
            const facts = await source.readCheckoutRevision(input);
            assertSource();
            return facts;
          },
          async readCheckoutBranchFacts(input, refresh) {
            assertSource();
            const facts = await source.readCheckoutBranchFacts(input, refresh);
            assertSource();
            return facts;
          },
        });
        assertSource();
        return result;
      });
    },
    async readTaskPublications(input: { branchUrls?: readonly string[] }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      assertCurrent();
      const result = await readTask(input, signal);
      signal?.throwIfAborted();
      assertCurrent();
      return result;
    },
  });
}
