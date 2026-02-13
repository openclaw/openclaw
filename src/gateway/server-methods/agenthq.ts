import fs from "node:fs/promises";
/**
 * AgentHQ Gateway RPC Handlers
 * Provides history, diff, and stats for agent workspace files.
 */
import type { GatewayRequestHandlers } from "./types.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  getGitHistory,
  getGitDiff,
  getGitStats,
  getFileAtCommit,
  isGitRepository,
  type GitStatsResult,
} from "../../services/git-history.js";
import { resolveUserPath } from "../../utils.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

// Tracked workspace files
const TRACKED_FILES = [
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "HEARTBEAT.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
];

type AgentHQHistoryParams = {
  agentId?: string;
  files?: string[];
  fileFilter?: string[];
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
};

type AgentHQDiffParams = {
  agentId: string;
  sha: string;
  fileName: string;
};

type AgentHQStatsParams = {
  agentId?: string;
  files?: string[];
  fileFilter?: string[];
  since?: string;
  until?: string;
};

type AgentHQFileParams = {
  agentId: string;
  sha: string;
  fileName: string;
};

type AgentHQSummaryParams = {
  agentId?: string;
  sha?: string;
  model?: string;
  provider?: string;
};

function validateAgentId(agentIdRaw: string | undefined): {
  valid: boolean;
  agentId: string | null;
  error?: string;
} {
  if (!agentIdRaw) {
    return { valid: false, agentId: null, error: "agentId is required" };
  }
  const cfg = loadConfig();
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return { valid: false, agentId: null, error: `unknown agent: ${agentId}` };
  }
  return { valid: true, agentId };
}

async function resolveWorkspacePath(agentId: string): Promise<string | null> {
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!workspaceDir) {
    return null;
  }
  const resolved = resolveUserPath(workspaceDir);
  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return null;
  }
}

export const agenthqHandlers: GatewayRequestHandlers = {
  /**
   * List git history for agent workspace files
   */
  "agenthq.history.list": async ({ params, respond }) => {
    const typedParams = params as AgentHQHistoryParams;
    const {
      agentId: agentIdRaw,
      files,
      fileFilter,
      limit = 50,
      offset = 0,
      since,
      until,
    } = typedParams;

    const validation = validateAgentId(agentIdRaw);
    if (!validation.valid || !validation.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, validation.error ?? "invalid agent"),
      );
      return;
    }

    const workspacePath = await resolveWorkspacePath(validation.agentId);
    if (!workspacePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspace not found"));
      return;
    }

    // Check if git repo exists
    const isGit = await isGitRepository(workspacePath);
    if (!isGit) {
      // Return empty result if not a git repo
      respond(true, {
        agentId: validation.agentId,
        workspace: workspacePath,
        entries: [],
        hasMore: false,
        isGitRepo: false,
      });
      return;
    }

    const requestedFiles = files && files.length > 0 ? files : fileFilter;
    const resolvedFilter =
      requestedFiles && requestedFiles.length > 0 ? requestedFiles : TRACKED_FILES;
    const history = await getGitHistory({
      workspacePath,
      fileFilter: resolvedFilter,
      limit,
      offset,
      since,
      until,
    });

    respond(true, {
      agentId: validation.agentId,
      workspace: workspacePath,
      entries: history.commits,
      hasMore: history.hasMore,
      isGitRepo: true,
    });
  },

  /**
   * Get diff for a specific commit and file
   */
  "agenthq.history.diff": async ({ params, respond }) => {
    const typedParams = params as AgentHQDiffParams;
    const { agentId: agentIdRaw, sha, fileName } = typedParams;

    if (!sha || !fileName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sha and fileName are required"),
      );
      return;
    }

    const validation = validateAgentId(agentIdRaw);
    if (!validation.valid || !validation.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, validation.error ?? "invalid agent"),
      );
      return;
    }

    const workspacePath = await resolveWorkspacePath(validation.agentId);
    if (!workspacePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspace not found"));
      return;
    }

    const diff = await getGitDiff(workspacePath, sha, fileName);
    if (!diff) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "diff not found"));
      return;
    }

    respond(true, diff);
  },

  /**
   * Get statistics for agent workspace changes
   */
  "agenthq.history.stats": async ({ params, respond }) => {
    const typedParams = params as AgentHQStatsParams;
    const { agentId: agentIdRaw, files, fileFilter, since, until } = typedParams;

    const validation = validateAgentId(agentIdRaw);
    if (!validation.valid || !validation.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, validation.error ?? "invalid agent"),
      );
      return;
    }

    const workspacePath = await resolveWorkspacePath(validation.agentId);
    if (!workspacePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspace not found"));
      return;
    }

    const isGit = await isGitRepository(workspacePath);
    if (!isGit) {
      respond(true, {
        agentId: validation.agentId,
        totalCommits: 0,
        filesChanged: {},
        activityByDay: [],
        lastChangeAt: null,
        firstChangeAt: null,
        isGitRepo: false,
      });
      return;
    }

    const requestedFiles = files && files.length > 0 ? files : fileFilter;
    const resolvedFilter =
      requestedFiles && requestedFiles.length > 0 ? requestedFiles : TRACKED_FILES;
    const stats = await getGitStats({
      workspacePath,
      fileFilter: resolvedFilter,
      since,
      until,
    });

    respond(true, {
      agentId: validation.agentId,
      ...stats,
      isGitRepo: true,
    });
  },

  /**
   * Get file content at a specific commit
   */
  "agenthq.file.at": async ({ params, respond }) => {
    const typedParams = params as AgentHQFileParams;
    const { agentId: agentIdRaw, sha, fileName } = typedParams;

    if (!sha || !fileName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sha and fileName are required"),
      );
      return;
    }

    const validation = validateAgentId(agentIdRaw);
    if (!validation.valid || !validation.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, validation.error ?? "invalid agent"),
      );
      return;
    }

    const workspacePath = await resolveWorkspacePath(validation.agentId);
    if (!workspacePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspace not found"));
      return;
    }

    const content = await getFileAtCommit(workspacePath, sha, fileName);
    respond(true, {
      agentId: validation.agentId,
      sha,
      fileName,
      content,
    });
  },

  /**
   * Generate a lightweight summary for a commit.
   * Note: this is currently deterministic metadata synthesis, not an LLM call.
   */
  "agenthq.summary.generate": async ({ params, respond }) => {
    const typedParams = params as AgentHQSummaryParams;
    const { agentId: agentIdRaw, sha, model, provider } = typedParams;
    if (!sha) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sha is required"));
      return;
    }
    const validation = validateAgentId(agentIdRaw);
    if (!validation.valid || !validation.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, validation.error ?? "invalid agent"),
      );
      return;
    }
    const workspacePath = await resolveWorkspacePath(validation.agentId);
    if (!workspacePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspace not found"));
      return;
    }
    const history = await getGitHistory({
      workspacePath,
      fileFilter: TRACKED_FILES,
      limit: 1000,
    });
    const commit = history.commits.find((entry) => entry.sha === sha);
    if (!commit) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "commit not found"));
      return;
    }
    const changedFiles = commit.files.map((file) => file.name.replace(".md", ""));
    const totalDelta = commit.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
    respond(true, {
      sha: commit.sha,
      agentId: validation.agentId,
      generatedAt: Date.now(),
      model: model ?? "agenthq-deterministic-v1",
      changes:
        changedFiles.length > 0
          ? changedFiles.map((name) => `Updated ${name} configuration`)
          : ["No tracked workspace file changes detected"],
      impact:
        totalDelta > 120
          ? "High-impact change touching multiple configuration areas."
          : totalDelta > 30
            ? "Moderate update with meaningful behavior adjustments."
            : "Small targeted refinement.",
      evolutionScore: Math.max(1, Math.min(10, Math.round(Math.log10(totalDelta + 1) * 4))),
      provider: provider ?? null,
    });
  },

  /**
   * List all agents with their workspace info for AgentHQ
   */
  "agenthq.agents.list": async ({ respond }) => {
    const cfg = loadConfig();
    const agentIds = listAgentIds(cfg);

    const agents = await Promise.all(
      agentIds.map(async (agentId) => {
        const workspacePath = await resolveWorkspacePath(agentId);
        const isGit = workspacePath ? await isGitRepository(workspacePath) : false;

        // Get basic stats if git repo
        let stats: GitStatsResult | null = null;
        if (workspacePath && isGit) {
          try {
            stats = await getGitStats({
              workspacePath,
              fileFilter: TRACKED_FILES,
              limit: 100,
            });
          } catch {
            // Ignore stats errors
          }
        }

        return {
          agentId,
          workspace: workspacePath,
          isGitRepo: isGit,
          totalCommits: stats?.totalCommits ?? 0,
          lastChangeAt: stats?.lastChangeAt ?? null,
          filesChanged: stats?.filesChanged ?? {},
        };
      }),
    );

    respond(true, { agents });
  },
};
