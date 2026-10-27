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
  resolveWorkspaceProject,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import type { ProjectRegistryRecord } from "../projects/project-registry.types.js";
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
  const pendingSource = selectSessionWorktreeProjectSource(params.projectId, params.signal);
  const source = pendingSource ? await pendingSource : undefined;
  params.assertCurrent();
  const project = source?.project ?? resolveWorkspaceProject(params.cfg, params.projectId);
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
  return { current, worktree: managed.ok && (current || source !== undefined) };
}
