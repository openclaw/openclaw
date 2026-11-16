import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
} from "../config/sessions/session-source-authority.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePluginRepositorySource } from "../plugins/repository-sources.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import type { RepositoryGatewayMaterializationParams } from "./session-repository-materialization.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { applyStagedWorkerWorkspace } from "./worker-environments/workspace-reconcile-apply.js";
import { restoreWorkerWorkspaceHistory } from "./worker-environments/workspace-result-history.js";

/** Restore accepted generic source results without enrolling them in native publication policy. */
export async function materializePluginRepositoryWorkspace(
  params: RepositoryGatewayMaterializationParams & {
    initial: GatewaySessionEntryRead;
    repository: SessionRepositoryWorkspaceRecord;
    repositorySourceId: string;
    assertRepositoryCurrent: () => void;
    snapshot: Pick<SessionRepositoryWorkspaceRecord, "checkpointRef" | "manifestHash">;
    verifyDisk?: () => Promise<void>;
  },
) {
  const { initial, repository } = params;
  const entry = initial.entry;
  if (!entry || !repository.baseCommit) {
    throw new Error("Repository workspace has no pinned source; retry its cloud preparation");
  }
  const target = {
    agentId: params.agentId,
    sessionKey: initial.canonicalKey,
    storePath: initial.storePath,
  };
  const entrySource = captureSessionEntrySourceAssertion({
    scope: target,
    readSource: initial.capturedReadSource,
    fields: ["sessionId", "lifecycleRevision", "repositoryWorkspaceId", "repositorySourceId"],
    expected: entry,
    assertCurrent: params.assertRepositoryCurrent,
    refuse: () => {
      throw new Error("Repository workspace changed during Gateway materialization; retry move");
    },
  });
  const assertOwner = composeSessionSourceAssertion(
    [params.assertCurrent, entrySource],
    (assertSources) => {
      params.signal?.throwIfAborted();
      assertSources();
      params.assertRepositoryCurrent();
    },
  );
  assertOwner();
  const source = resolvePluginRepositorySource(params.repositorySourceId, repository.url);
  const checkout = await source.prepare({
    agentId: params.agentId,
    requiredCommit: repository.baseCommit,
    signal: params.signal,
    assertCurrent: assertOwner,
  });
  const assertCurrent = composeSessionSourceAssertion([assertOwner], (assertSources) => {
    assertSources();
    source.assertCurrent();
    checkout.assertCurrent();
  });
  assertCurrent();
  const prepared = await prepareSessionWorktree({
    cfg: params.cfg,
    target: {
      ...target,
      key: target.sessionKey,
      entry,
      projectId: checkout.project.id,
      sandboxRequired: entry.sandbox === "required",
    },
    workspace: checkout.project.repoRoot,
    name: repository.workspaceId,
    baseRef: repository.requestedRef ?? "HEAD",
    checkoutCommit: repository.baseCommit,
    runSetupScript: false,
    signal: params.signal,
    commitGuard: assertCurrent,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const workspace = prepared.value;
  if (!workspace.spawnedCwd || !workspace.worktree) {
    throw new Error("Repository materialization did not create a managed worktree");
  }
  let bound = false;
  try {
    if (params.snapshot.checkpointRef) {
      await withSessionRepositoryCheckpoint(
        { workspaceId: repository.workspaceId, checkpointRef: params.snapshot.checkpointRef },
        async (snapshot) => {
          assertCurrent();
          const applied = await applyStagedWorkerWorkspace({
            ...snapshot,
            acceptance: { kind: "reconcile" },
            root: workspace.spawnedCwd!,
            journal: {
              load: async () => undefined,
              begin: async () => assertCurrent(),
              commit: async () => assertCurrent(),
              abort: async () => {},
            },
          });
          if (
            applied.conflictPaths.length ||
            applied.manifestRef !== params.snapshot.manifestHash
          ) {
            throw new Error(
              "Repository changes could not be fully restored; retry the Gateway move",
            );
          }
          await applied.verifyLocalStable();
          const historyNote = await restoreWorkerWorkspaceHistory({
            ...snapshot,
            root: workspace.spawnedCwd!,
            assertCurrent,
          });
          if (historyNote && repository.diskAuthority) {
            throw new Error(
              "Repository disk history could not be restored exactly; the original disk is preserved",
            );
          }
          if (historyNote) {
            createSubsystemLogger("gateway/worker-workspace").info(historyNote);
          }
          await applied.verifyLocalStable();
          assertCurrent();
        },
      );
    }
    await params.verifyDisk?.();
    assertCurrent();
    const bind = async (assertSourceCurrent: () => void) =>
      await patchSessionEntryCore(
        target,
        (current) => {
          assertCurrent();
          assertSourceCurrent();
          if (
            current?.sessionId !== params.sessionId ||
            current.lifecycleRevision !== entry.lifecycleRevision ||
            current.repositoryWorkspaceId !== repository.workspaceId ||
            current.repositorySourceId !== params.repositorySourceId
          ) {
            throw new Error(
              "Repository workspace changed during Gateway materialization; retry move",
            );
          }
          return {
            ...current,
            repositoryWorkspaceId: undefined,
            projectId: checkout.project.id,
            spawnedCwd: workspace.spawnedCwd,
            sessionRoot: workspace.sessionRoot,
            worktree: workspace.worktree,
          };
        },
        {
          replaceEntry: true,
          ...sessionEntryCommitGuardOptions(
            composeSessionSourceAssertion([assertCurrent, assertSourceCurrent]),
          ),
          requireWriteSuccess: true,
          skipMaintenance: true,
          onCommitted: () => {
            bound = true;
          },
        },
      );
    const result = workspace.withCommit ? await workspace.withCommit(bind) : await bind(() => {});
    if (!result) {
      throw new Error("Session disappeared before repository materialization committed");
    }
  } finally {
    if (!bound) {
      await workspace.rollback?.();
    }
  }
}
