import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveProjectRegistry,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import type { ProjectRegistryRecord } from "../projects/project-registry.types.js";
import type { ExecutionSkillWorkspace } from "../skills/loading/workspace-skill-roots.js";
import { prepareSessionCreateFilesystemRoot } from "./server-methods/session-create-root.js";

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
  resolveSandboxRequired: () => boolean;
  assertCurrent: () => void;
}): Promise<ExecutionSkillWorkspace | undefined> {
  params.assertCurrent();
  const project = await resolveProjectRegistry(params.cfg, params.projectId);
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
  resolveSandboxRequired: () => boolean;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{ current: boolean; worktree: boolean }> {
  params.assertCurrent();
  const project = await resolveProjectRegistry(params.cfg, params.projectId);
  params.assertCurrent();
  if (!project) {
    return { current: false, worktree: false };
  }
  const [direct, managed] = await Promise.all([
    resolveSessionProjectRootForRecord(project, false),
    resolveSessionProjectRootForRecord(project, true),
  ]);
  params.assertCurrent();
  const current =
    direct.ok &&
    prepareSessionCreateFilesystemRoot({
      cfg: params.cfg,
      requestedProjectId: params.projectId,
      targetAgentId: params.targetAgentId,
      sessionCwd: direct.value,
      enforceSandboxContainment: true,
      sandboxRequired: params.resolveSandboxRequired(),
    }).ok;
  return { current, worktree: managed.ok && (current || project.source !== "workspace") };
}
