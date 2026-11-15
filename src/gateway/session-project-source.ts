import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveWorkspaceProject,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import type { ProjectRegistryRecord } from "../projects/project-registry.types.js";
import type { ExecutionSkillWorkspace } from "../skills/loading/workspace-skill-roots.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { type ProjectRequester, resolveRequesterProject } from "./project-access.js";
import { prepareSessionCreateFilesystemRoot } from "./server-methods/session-create-root.js";
import type { PreparedGatewaySessionLifecycle } from "./session-create-service.types.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { withGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";

/** The inspected PR base identifies the project; fork names alone never select local source. */
export async function resolvePullRequestProjectSource(
  cfg: OpenClawConfig,
  source: { host: string; repository: string; requester: ProjectRequester },
): Promise<ProjectRegistryRecord | undefined> {
  const matches = (project: ProjectRegistryRecord) =>
    project.originUrl &&
    parseProjectGitUrl(project.originUrl, source.host)?.url ===
      `https://${source.host}/${source.repository.toLowerCase()}.git`;
  const candidate = (await listProjectRegistry(cfg)).find(matches);
  const project = candidate
    ? await resolveRequesterProject(cfg, candidate.id, source.requester, { fresh: true })
    : undefined;
  return project && matches(project) ? project : undefined;
}

export async function resolveSessionProjectRootForRecord(
  project: ProjectRegistryRecord,
  worktree: boolean,
): Promise<Result<string, ErrorShape>> {
  try {
    const checkout = worktree ? await resolveProjectCheckout(project.repoRoot) : undefined;
    const root = checkout?.path ?? (await resolveProjectDirectory(project.repoRoot));
    if (checkout && project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
      throw new ProjectCheckoutError("project root is no longer a git checkout");
    }
    return ok(root);
  } catch (error) {
    const detail =
      error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `project ${project.id} is unavailable (${detail}); update the agent workspace path or re-register the project`,
      ),
    );
  }
}

export function selectSessionWorktreeProjectSource(
  projectId: string | undefined,
  signal?: AbortSignal,
) {
  return projectId && !projectId.startsWith("workspace:")
    ? selectStoredProjectRegistry(projectId, { signal })
    : undefined;
}

/**
 * Advisory command discovery reads skills only from the direct project root that
 * session creation would admit for this agent, including sandbox containment.
 * The registry's source classification decides the file host: registered and cloned
 * checkouts are Gateway-owned; the agent-workspace pseudo-project keeps the
 * workspace's own host, exactly as the created session's resolver does.
 */
export async function resolveSessionProjectSkillRoot(params: {
  cfg: OpenClawConfig;
  projectId: string;
  targetAgentId: string;
  requester: ProjectRequester;
  resolveSandboxRequired: () => boolean;
  assertCurrent: () => void;
}): Promise<ExecutionSkillWorkspace | undefined> {
  params.assertCurrent();
  const project = await resolveRequesterProject(params.cfg, params.projectId, params.requester);
  params.assertCurrent();
  if (!project) {
    return undefined;
  }
  const direct = await resolveSessionProjectRootForRecord(project, false);
  params.assertCurrent();
  if (!direct.ok) {
    return undefined;
  }
  const admitted = prepareSessionCreateFilesystemRoot({
    cfg: params.cfg,
    requestedProjectId: params.projectId,
    targetAgentId: params.targetAgentId,
    sessionCwd: direct.value,
    enforceSandboxContainment: true,
    sandboxRequired: params.resolveSandboxRequired(),
  });
  const root = admitted.ok ? admitted.value.sessionCwd : undefined;
  return root
    ? {
        executionWorkspaceDir: root,
        ...(project.source === "workspace"
          ? {}
          : { executionWorkspaceFileHost: "gateway" as const }),
      }
    : undefined;
}

/** Advisory discovery shares source custody classification with managed creation. */
export async function resolveSessionProjectCheckoutOptions(params: {
  cfg: OpenClawConfig;
  projectId: string;
  targetAgentId: string;
  requester: ProjectRequester;
  resolveSandboxRequired: () => boolean;
  assertCurrent: () => void;
  signal?: AbortSignal;
  onRefresh?: () => void;
}): Promise<{ current: boolean; worktree: boolean; refreshing?: boolean }> {
  params.assertCurrent();
  const project = await resolveRequesterProject(params.cfg, params.projectId, params.requester);
  params.assertCurrent();
  if (!project) {
    return { current: false, worktree: false };
  }
  if (project.source === "cloned") {
    return { current: false, worktree: true };
  }
  const direct = prepareSessionCreateFilesystemRoot({
    cfg: params.cfg,
    requestedProjectId: params.projectId,
    targetAgentId: params.targetAgentId,
    sessionCwd: project.repoRoot,
    enforceSandboxContainment: true,
    sandboxRequired: params.resolveSandboxRequired(),
  });
  const current = direct.ok;
  const root = direct.ok ? direct.value.sessionCwd : undefined;
  // Registered projects already record a committed checkout. Creation validates it
  // again; the picker only needs discovery for agent-workspace pseudo-projects.
  const repository =
    project.source === "workspace" && root
      ? await runGitReadOperation(
          {
            type: "repository.branches",
            input: { repoRoot: root, includeRepositoryStatus: true },
          },
          { snapshot: true, signal: params.signal, onRefresh: params.onRefresh },
        )
      : undefined;
  params.assertCurrent();
  return {
    current,
    worktree: project.source !== "workspace" || (current && repository?.repositoryStatus === "git"),
    ...(repository?.refreshing ? { refreshing: true } : {}),
  };
}

export type SpawnParentWorktreeSource = {
  kind: "worktree";
  workspace: string;
  /** Registry project the parent was created from; absent for cwd-based worktrees. */
  projectId?: string;
  source?: NonNullable<PreparedGatewaySessionLifecycle["pendingWorktree"]>["source"];
  withCurrent: WorktreeSourceStage;
  withRollback?: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};

type SpawnParentRepositorySource = {
  kind: "repository";
  sessionId: string;
  repository: SessionRepositoryWorkspaceRecord;
  assertCurrent: SessionSourceAssertion;
};

export async function resolveSpawnParentWorktreeSource(
  parentSessionKey: string,
  agentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SpawnParentWorktreeSource | SpawnParentRepositorySource | undefined> {
  return withGatewaySessionEntryReadOnly(
    {
      cfg: getRuntimeConfig(),
      key: parentSessionKey,
      agentId,
      assertActive: () => options.signal?.throwIfAborted(),
    },
    async (parent) => prepareSpawnParentWorktreeSource(parent, agentId, options),
  );
}

async function prepareSpawnParentWorktreeSource(
  parent: GatewaySessionEntryRead,
  agentId: string,
  options: { signal?: AbortSignal },
): Promise<SpawnParentWorktreeSource | SpawnParentRepositorySource | undefined> {
  if (!parent.entry) {
    return undefined;
  }
  const fields = [
    "sessionId",
    "lifecycleRevision",
    "archivedAt",
    "projectId",
    "sessionRoot",
    "worktree",
    "repositoryWorkspaceId",
  ] as const;
  const sourceKind = parent.entry.repositoryWorkspaceId
    ? "repository"
    : parent.entry.worktree
      ? "managed worktree"
      : "project";
  const refuse = (): never => {
    throw new SessionWorktreeSourceChangedError(
      `Spawn parent ${sourceKind} changed; retry from its current session`,
    );
  };
  const scope = { agentId, sessionKey: parent.canonicalKey, storePath: parent.storePath };
  const assertRouting = captureSessionMutationRouting(parent.cfg, refuse, [scope]);
  const assertHostCurrent = () => {
    options.signal?.throwIfAborted();
    assertRouting(getRuntimeConfig());
  };
  const parentSource = captureSessionEntrySourceAssertion({
    scope,
    readSource: parent.capturedReadSource,
    expected: parent.entry,
    fields,
    assertCurrent: assertHostCurrent,
    assertHostCurrent,
    refuse,
  });
  if (parent.entry.repositoryWorkspaceId) {
    const prepared = await getSessionRepositoryWorkspaceStore().prepare(
      parent.entry.repositoryWorkspaceId,
    );
    const repository = prepared.workspace;
    if (
      !repository ||
      repository.agentId !== agentId ||
      repository.sessionKey !== parent.canonicalKey ||
      parent.entry.archivedAt !== undefined
    ) {
      return refuse();
    }
    const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
      assertSources();
      if (prepared.current()?.revision !== repository.revision) {
        refuse();
      }
    });
    assertCurrent();
    return { kind: "repository", sessionId: parent.entry.sessionId, repository, assertCurrent };
  }
  if (!parent.entry.worktree) {
    const projectId = normalizeOptionalString(parent.entry.projectId);
    if (!projectId) {
      return undefined;
    }
    const selection = projectId.startsWith("workspace:")
      ? undefined
      : await selectStoredProjectRegistry(projectId, options);
    const project = selection?.project ?? resolveWorkspaceProject(parent.cfg, projectId);
    if (!project) {
      throw new SessionWorktreeSourceChangedError(
        "Spawn parent project changed; retry from its current session",
      );
    }
    const assertParentCurrent = (storedRoot: string | undefined, assertCheckout?: () => void) => {
      assertCheckout?.();
      const currentProjectRoot = selection
        ? storedRoot
        : resolveWorkspaceProject(getRuntimeConfig(), projectId)?.repoRoot;
      if (
        parent.entry?.archivedAt !== undefined ||
        parent.entry?.sessionRoot !== project.repoRoot ||
        currentProjectRoot !== project.repoRoot
      ) {
        throw new SessionWorktreeSourceChangedError(
          "Spawn parent project changed; retry from its current session",
        );
      }
    };
    if (selection) {
      return {
        kind: "worktree",
        workspace: project.repoRoot,
        projectId,
        source: { kind: "project", id: projectId },
        withRollback: selection.withRollback,
        withCurrent: async (run, acquisition) =>
          await selection.withCurrent((current) => {
            const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
              assertSources();
              assertParentCurrent(current.project?.repoRoot, current.assertCurrent);
            });
            return run({
              assertCurrent,
              assertCheckoutCurrent: current.assertCheckoutCurrent,
              signal: current.signal,
            });
          }, acquisition),
      };
    }
    const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
      assertSources();
      assertParentCurrent(undefined);
    });
    assertCurrent();
    return {
      kind: "worktree",
      workspace: project.repoRoot,
      projectId,
      source: { kind: "project", id: projectId },
      withCurrent: async (run) => await run({ assertCurrent, signal: options.signal }),
    };
  }
  const context = captureWorktreeRunEndContext(process.env);
  const accept = captureWorktreeRegistryReadGuard(context, "source-owner", {
    id: parent.entry.worktree.id,
    ownerKind: "session",
    ownerId: parent.canonicalKey,
  });
  const worktree = await readLiveRegistryWorktreeByOwner(context, "session", parent.canonicalKey);
  const assertWorktreeCurrent = accept(worktree);
  options.signal?.throwIfAborted();
  if (
    !worktree ||
    worktree.id !== parent.entry.worktree.id ||
    parent.entry.archivedAt !== undefined
  ) {
    throw new SessionWorktreeSourceChangedError(
      "Spawn parent managed worktree changed; retry from its current session",
    );
  }
  // Validate the inherited source through the child creation commit. After that,
  // persisted workspace intent belongs to the child and uses its admitted run.
  const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
    assertSources();
    assertWorktreeCurrent();
  });
  assertCurrent();
  const projectId = normalizeOptionalString(parent.entry.projectId);
  return {
    kind: "worktree",
    workspace: worktree.repoRoot,
    ...(projectId ? { projectId } : {}),
    source: { kind: "worktree", id: worktree.id },
    withCurrent: async (run) =>
      await run({
        assertCurrent,
        signal: options.signal,
        workerAuthority: {
          assertCurrent: parentSource,
          predicates: [
            {
              kind: "source-owner",
              ownerId: parent.canonicalKey,
              id: worktree.id,
              path: worktree.path,
              repoRoot: worktree.repoRoot,
            },
          ],
        },
      }),
  };
}
