import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeMsgContext, TemplateContext } from "../templating.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

/** Turns and active-run steers stage against the same session workspace and private skills. */
export async function stageReplyMedia(params: {
  ctx: RuntimeMsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  sessionEntry?: SessionEntry;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  awaitSessionDiffBaseline?: () => Promise<void>;
}) {
  const { sessionEntry, workspaceDir, cfg, agentId } = params;
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    params.assertCurrent?.();
  };
  assertCurrent();
  const stagingWorkspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: sessionEntry?.spawnedBy,
      workspaceDir: sessionEntry?.spawnedWorkspaceDir,
      cwd: sessionEntry?.spawnedCwd,
    }) ?? workspaceDir;
  // Private selections affect sandbox identity; a stale snapshot must not select another runtime.
  const selectedSkills =
    sessionEntry?.skillLibrarySelections ?? sessionEntry?.skillsSnapshot?.librarySelections;
  const skillsSnapshot = selectedSkills?.length
    ? (
        await (
          await import("../../skills/runtime/session-snapshot.js")
        ).resolveReusableWorkspaceSkillSnapshot({
          workspaceDir,
          config: cfg,
          agentId,
          executionWorkspaceDir: sessionEntry?.worktree?.canonicalWorkspaceDir ?? workspaceDir,
          existingSnapshot: sessionEntry?.skillsSnapshot,
          librarySelections: selectedSkills,
          skillFilter: params.skillFilter,
          skillOverrides: params.skillOverrides,
          assertCurrent,
        })
      ).snapshot
    : undefined;
  assertCurrent();
  const result = await stageSandboxMedia({
    ctx: params.ctx,
    sessionCtx: params.sessionCtx,
    cfg,
    agentId,
    sessionKey: params.sessionKey,
    workspaceDir: stagingWorkspaceDir,
    skillsSnapshot,
    abortSignal: params.abortSignal,
    assertCurrent,
    awaitSessionDiffBaseline: params.awaitSessionDiffBaseline,
  });
  assertCurrent();
  return result;
}
