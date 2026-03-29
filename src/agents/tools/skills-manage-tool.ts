import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  createProposal,
  deleteProposal,
  detectSecrets,
  getProposal,
  listProposals,
  projectSkillsManageBudget,
  resolveSkillRoot,
  type SkillsManageTargetRoot,
} from "../skills/skills-manage-proposals.js";
import { resolveSkillsLimits } from "../skills/workspace.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SKILLS_MANAGE_PREVIEW_MAX_CHARS = 1200;

const SkillsManageToolSchema = Type.Object({
  action: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  contents: Type.Optional(Type.String()),
  proposalId: Type.Optional(Type.String()),
});

function parseTargetRoot(raw?: string): SkillsManageTargetRoot | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw === "workspace" || raw === "project-agents") {
    return raw;
  }
  return undefined;
}

function truncatePreview(contents: string): string {
  if (contents.length <= SKILLS_MANAGE_PREVIEW_MAX_CHARS) {
    return contents;
  }
  return `${truncateUtf16Safe(contents, SKILLS_MANAGE_PREVIEW_MAX_CHARS)}\n…(truncated preview)…`;
}

export function createSkillsManageTool(opts: {
  workspaceDir: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Skills Manage",
    name: "skills_manage",
    description: "Propose and approve SKILL.md files in workspace skill roots.",
    ownerOnly: true,
    parameters: SkillsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true })?.toLowerCase();
      if (action === "list") {
        return jsonResult({
          ok: true,
          action,
          proposals: listProposals(opts.agentSessionKey),
        });
      }

      if (action === "delete") {
        const proposalId = readStringParam(params, "proposalId", { required: true });
        return jsonResult({
          ok: true,
          action,
          deleted: deleteProposal(proposalId),
        });
      }

      if (action === "propose") {
        const name = readStringParam(params, "name", { required: true });
        const contents = readStringParam(params, "contents", { required: true, trim: false });
        const targetRaw = readStringParam(params, "target");
        const target = parseTargetRoot(targetRaw);
        if (targetRaw && !target) {
          return jsonResult({
            ok: false,
            action,
            error: "target must be 'workspace' or 'project-agents'",
          });
        }
        const created = createProposal({
          workspaceDir: opts.workspaceDir,
          targetRoot: target,
          name,
          contents,
          createdBySessionKey: opts.agentSessionKey,
        });
        if (!created.ok) {
          return jsonResult({
            ok: false,
            action,
            error: created.error,
          });
        }
        return jsonResult({
          ok: true,
          action,
          proposal: {
            ...created.proposal,
            preview: truncatePreview(created.proposal.contents),
          },
        });
      }

      if (action === "approve") {
        const proposalId = readStringParam(params, "proposalId", { required: true });
        const proposal = getProposal(proposalId);
        if (!proposal) {
          return jsonResult({
            ok: false,
            action,
            error: "proposal not found",
          });
        }

        const targetRoot = resolveSkillRoot(opts.workspaceDir, proposal.targetRoot);
        if (
          !isPathInside(targetRoot.rootPath, proposal.skillDir) ||
          !isPathInside(targetRoot.rootPath, proposal.skillMdPath)
        ) {
          return jsonResult({
            ok: false,
            action,
            error: "proposal path is outside allowed skill roots",
          });
        }

        const limits = resolveSkillsLimits(opts.config);
        const sizeBytes = Buffer.byteLength(proposal.contents, "utf8");
        if (sizeBytes > limits.maxSkillFileBytes) {
          return jsonResult({
            ok: false,
            action,
            error: `skill file too large (${sizeBytes} > ${limits.maxSkillFileBytes} bytes)`,
          });
        }

        const secretCheck = detectSecrets(proposal.contents);
        if (!secretCheck.ok) {
          return jsonResult({
            ok: false,
            action,
            error: "proposal rejected: detected sensitive content",
            matches: secretCheck.matches,
          });
        }

        const budget = projectSkillsManageBudget({
          workspaceDir: opts.workspaceDir,
          contents: proposal.contents,
          config: opts.config,
        });
        if (!budget.ok) {
          return jsonResult({
            ok: false,
            action,
            error: budget.error ?? "proposal exceeds skills prompt budget",
          });
        }

        await fs.mkdir(targetRoot.rootPath, { recursive: true });
        let resolvedAllowedRoot: string;
        try {
          resolvedAllowedRoot = await fs.realpath(targetRoot.rootPath);
        } catch {
          return jsonResult({
            ok: false,
            action,
            error: "could not resolve skill root path",
          });
        }
        const relSkillDir = path.relative(targetRoot.rootPath, proposal.skillDir);
        if (!relSkillDir || relSkillDir.startsWith("..") || path.isAbsolute(relSkillDir)) {
          return jsonResult({
            ok: false,
            action,
            error: "proposal path is outside allowed skill roots",
          });
        }
        const relParts = path.normalize(relSkillDir).split(path.sep).filter(Boolean);
        let resolvedSkillDir = resolvedAllowedRoot;
        try {
          for (const part of relParts) {
            const nextPath = path.join(resolvedSkillDir, part);
            const st = await fs.lstat(nextPath).catch(() => null);
            if (!st) {
              await fs.mkdir(nextPath);
            } else if (!st.isDirectory() && !st.isSymbolicLink()) {
              return jsonResult({
                ok: false,
                action,
                error: "skill path blocked by a non-directory file",
              });
            }
            const resolvedNext = await fs.realpath(nextPath);
            if (!isPathInside(resolvedAllowedRoot, resolvedNext)) {
              return jsonResult({
                ok: false,
                action,
                error: "proposal path escapes allowed skill roots after symlink resolution",
              });
            }
            resolvedSkillDir = resolvedNext;
          }
        } catch {
          return jsonResult({
            ok: false,
            action,
            error: "could not resolve proposal paths after mkdir",
          });
        }
        const resolvedSkillMdPath = path.join(
          resolvedSkillDir,
          path.basename(proposal.skillMdPath),
        );
        if (!isPathInside(resolvedAllowedRoot, resolvedSkillMdPath)) {
          return jsonResult({
            ok: false,
            action,
            error: "proposal path escapes allowed skill roots after symlink resolution",
          });
        }
        const mdStat = await fs.lstat(resolvedSkillMdPath).catch(() => null);
        if (mdStat?.isSymbolicLink()) {
          let realMd: string;
          try {
            realMd = await fs.realpath(resolvedSkillMdPath);
          } catch {
            return jsonResult({
              ok: false,
              action,
              error: "could not resolve SKILL.md path",
            });
          }
          if (!isPathInside(resolvedAllowedRoot, realMd)) {
            return jsonResult({
              ok: false,
              action,
              error: "proposal path escapes allowed skill roots after symlink resolution",
            });
          }
        }
        await fs.writeFile(resolvedSkillMdPath, proposal.contents, "utf8");
        deleteProposal(proposalId);

        return jsonResult({
          ok: true,
          action,
          skillMdPath: resolvedSkillMdPath,
          targetRoot: proposal.targetRoot,
          sizeBytes,
        });
      }

      return jsonResult({
        ok: false,
        action,
        error: "unsupported action",
      });
    },
  };
}
