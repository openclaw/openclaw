import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { loadSessionEntry } from "../../gateway/session-utils.js";
import {
  describeEnterWorktreeTool,
  ENTER_WORKTREE_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import {
  createSessionWorktree,
  removeSessionWorktree,
  resolveRuntimeWorkspaceDirForSession,
} from "../worktree-runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const EnterWorktreeToolSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Optional short suffix for the worktree path." })),
  branch: Type.Optional(
    Type.String({ description: "Optional new branch name to create for the worktree." }),
  ),
  baseRef: Type.Optional(
    Type.String({ description: "Optional base ref or commit for the new worktree." }),
  ),
  cleanup: Type.Optional(
    Type.Union([Type.Literal("keep"), Type.Literal("remove")], {
      description: "Preferred cleanup policy when ExitWorktree is called later.",
    }),
  ),
});

type GatewayCaller = typeof callGateway;

export function createEnterWorktreeTool(opts: {
  agentSessionKey: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Enter Worktree",
    name: "EnterWorktree",
    displaySummary: ENTER_WORKTREE_TOOL_DISPLAY_SUMMARY,
    description: describeEnterWorktreeTool(),
    searchHint: "Create an isolated git worktree for the current session.",
    searchTags: ["git", "worktree", "branch", "workspace", "isolation"],
    parameters: EnterWorktreeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("agent session key required");
      }

      const loaded = loadSessionEntry(sessionKey);
      const existingArtifact = loaded.entry?.worktreeArtifact;
      if (loaded.entry?.worktreeMode === "active" && existingArtifact?.worktreeDir) {
        return jsonResult({
          status: "already_active",
          sessionKey,
          worktreeDir: existingArtifact.worktreeDir,
          repoRoot: existingArtifact.repoRoot,
          branch: existingArtifact.branch,
          effectiveOnNextTurn: true,
        });
      }

      const workspaceDir = resolveRuntimeWorkspaceDirForSession({
        sessionEntry: loaded.entry,
        fallbackWorkspaceDir: opts.workspaceDir,
      });
      if (!workspaceDir) {
        throw new ToolInputError("workspaceDir required");
      }

      const cleanup = params.cleanup === "remove" ? "remove" : "keep";
      const artifact = await createSessionWorktree({
        sessionKey,
        workspaceDir,
        requestedName: readStringParam(params, "name"),
        branch: readStringParam(params, "branch"),
        baseRef: readStringParam(params, "baseRef"),
        cleanupPolicy: cleanup,
      });

      const gatewayCall = opts.callGateway ?? callGateway;
      try {
        await gatewayCall({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            worktreeMode: "active",
            worktreeArtifact: artifact,
          },
          config: opts.config,
        });
      } catch (error) {
        const rollback = await removeSessionWorktree({
          repoRoot: artifact.repoRoot,
          worktreeDir: artifact.worktreeDir,
          force: true,
        });
        if (!rollback.removed) {
          const rollbackError = rollback.error ? ` Rollback failed: ${rollback.error}` : "";
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}${rollbackError}`,
            { cause: error },
          );
        }
        throw error;
      }

      return jsonResult({
        status: "active",
        sessionKey,
        repoRoot: artifact.repoRoot,
        worktreeDir: artifact.worktreeDir,
        branch: artifact.branch,
        baseRef: artifact.baseRef,
        cleanupPolicy: artifact.cleanupPolicy,
        effectiveOnNextTurn: true,
        previousWorkspaceDir: workspaceDir,
      });
    },
  };
}
