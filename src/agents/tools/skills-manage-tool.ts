import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  approveProposal,
  createProposal,
  deleteProposal,
  hashSkillFileContent,
  listProposals,
  readSkillMdFromDisk,
  resolveSkillsManageRuntime,
  tryApplyPatch,
  type SkillsManageTargetRoot,
} from "../skills/skills-manage-proposals.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SKILLS_MANAGE_DESCRIPTION = [
  "Gated workspace skills: propose, update, or patch SKILL.md drafts in memory; only approve writes to disk.",
  "",
  "ACTIONS: propose | update | patch | list | approve | delete",
  "- propose/update/patch/list/delete: no disk writes.",
  "- approve: single write path to skills/<name>/SKILL.md after containment, secrets, size, budget, and quality checks.",
  "",
  "WHEN TO PROPOSE: recurring or multi-step success; user asked to persist; skip trivial one-offs.",
  "",
  "ARGUMENTS: propose needs name, content, targetRoot (workspace|project-agents). update needs name, content, targetRoot if needed.",
  "patch needs name, oldString, newString, optional replaceAll, targetRoot. approve/delete need proposalId. list must omit mutation fields.",
  "",
  "RECOVERY: missing_argument → add fields; invalid_action_arguments → remove forbidden fields for action;",
  "proposal_not_found → list then retry; quality_incomplete → add listed sections; quality_too_verbose → shorten;",
  "patch_base_stale → re-patch from current disk SKILL.md; budget_exceeded → reduce catalog or raise limits;",
  "skill_not_found on update/patch → skill must exist on disk (not only pending).",
].join("\n");

const SkillsManageToolSchema = Type.Object({
  action: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  /** @deprecated prefer `content` */
  contents: Type.Optional(Type.String()),
  targetRoot: Type.Optional(Type.String()),
  /** @deprecated prefer `targetRoot` */
  target: Type.Optional(Type.String()),
  proposalId: Type.Optional(Type.String()),
  oldString: Type.Optional(Type.String()),
  newString: Type.Optional(Type.String()),
  replaceAll: Type.Optional(Type.Boolean()),
});

function parseTargetRoot(raw?: string): SkillsManageTargetRoot | undefined {
  if (!raw) {
    return undefined;
  }
  const v = raw.trim();
  if (v === "workspace" || v === "project-agents") {
    return v;
  }
  return undefined;
}

function readContentParam(params: Record<string, unknown>): string | undefined {
  const direct = readStringParam(params, "content", { trim: false });
  if (direct !== undefined) {
    return direct;
  }
  return readStringParam(params, "contents", { trim: false });
}

function err(
  action: string,
  errorCode: string,
  error: string,
  hint?: string,
): ReturnType<typeof jsonResult> {
  return jsonResult({ status: "error", action, errorCode, error, ...(hint ? { hint } : {}) });
}

export function createSkillsManageTool(opts: {
  workspaceDir: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Skills Manage",
    name: "skills_manage",
    description: SKILLS_MANAGE_DESCRIPTION,
    ownerOnly: true,
    parameters: SkillsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const actionRaw = readStringParam(params, "action", { required: true });
      const action = actionRaw?.toLowerCase().trim() ?? "";
      const runtime = resolveSkillsManageRuntime(opts.config);
      if (!runtime.enabled) {
        return err(action, "disabled", "skills_manage is disabled by configuration");
      }

      if (action === "list") {
        const forbidden = [
          "content",
          "contents",
          "name",
          "oldString",
          "newString",
          "proposalId",
        ].filter((k) => params[k] != null && params[k] !== "");
        if (forbidden.length > 0) {
          return err(
            action,
            "invalid_action_arguments",
            "list does not accept mutation fields",
            "Remove extra fields and call list again.",
          );
        }
        const rows = listProposals(opts.agentSessionKey).map((p) => ({
          proposalId: p.id,
          name: p.name,
          kind: p.kind,
          targetRoot: p.targetRoot,
          createdAt: p.createdAt,
          lastTouchedAt: p.lastTouchedAt,
          sourceSessionKey: p.sourceSessionKey,
          triggerReason: p.triggerReason,
          summaryLine: p.contents
            .split("\n")
            .find((l) => l.trim().length > 0)
            ?.slice(0, 120),
        }));
        return jsonResult({
          status: "ok",
          action,
          persisted: false,
          proposals: rows,
        });
      }

      if (action === "delete") {
        const proposalId = readStringParam(params, "proposalId", { required: true });
        if (!proposalId) {
          return err(
            action,
            "missing_argument",
            "proposalId is required",
            "Pass proposalId from a prior propose/update/patch.",
          );
        }
        const ok = deleteProposal(proposalId);
        if (!ok) {
          return err(
            action,
            "proposal_not_found",
            "proposal not found",
            "Call list, then retry with a valid proposalId.",
          );
        }
        return jsonResult({ status: "ok", action, persisted: false, deleted: true });
      }

      if (action === "approve") {
        const proposalId = readStringParam(params, "proposalId", { required: true });
        if (!proposalId) {
          return err(action, "missing_argument", "proposalId is required");
        }
        const forbidden = ["content", "contents", "name", "oldString", "newString"].some(
          (k) => params[k] != null && String(params[k]).length > 0,
        );
        if (forbidden) {
          return err(
            action,
            "invalid_action_arguments",
            "approve only accepts proposalId",
            "Remove body fields and pass proposalId only.",
          );
        }
        const result = await approveProposal({
          proposalId,
          workspaceDir: opts.workspaceDir,
          config: opts.config,
          agentId: opts.agentId,
        });
        if (!result.ok) {
          return err(action, result.errorCode, result.error, result.hint);
        }
        return jsonResult({
          status: "ok",
          action,
          persisted: true,
          path: result.path,
          appliedChecks: result.appliedChecks,
        });
      }

      if (action === "propose") {
        if (params.proposalId) {
          return err(action, "invalid_action_arguments", "propose must not include proposalId");
        }
        const name = readStringParam(params, "name", { required: true });
        const content = readContentParam(params);
        const targetRaw =
          readStringParam(params, "targetRoot") ?? readStringParam(params, "target");
        const targetRoot = parseTargetRoot(targetRaw);
        if (targetRaw && !targetRoot) {
          return err(
            action,
            "invalid_action_arguments",
            "targetRoot must be workspace or project-agents",
          );
        }
        if (!name || !content) {
          return err(action, "missing_argument", "name and content are required for propose");
        }
        const created = createProposal({
          workspaceDir: opts.workspaceDir,
          targetRoot,
          name,
          contents: content,
          kind: "new",
          sourceSessionKey: opts.agentSessionKey,
          config: opts.config,
          agentId: opts.agentId,
        });
        if (!created.ok) {
          return err(action, created.errorCode, created.error, created.hint);
        }
        return jsonResult({
          status: "ok",
          action,
          persisted: false,
          proposalId: created.proposal.id,
          quality: created.quality,
          budgetPreview: created.budgetPreview,
        });
      }

      if (action === "update") {
        const name = readStringParam(params, "name", { required: true });
        const content = readContentParam(params);
        const targetRaw =
          readStringParam(params, "targetRoot") ?? readStringParam(params, "target");
        const targetRoot = parseTargetRoot(targetRaw) ?? "workspace";
        if (!name || !content) {
          return err(action, "missing_argument", "name and content are required for update");
        }
        const disk = await readSkillMdFromDisk(opts.workspaceDir, name, targetRoot);
        if (!disk.ok) {
          return err(
            action,
            "skill_not_found",
            "skill not found on disk",
            "update reads only on-disk SKILL.md; create a propose for new skills.",
          );
        }
        const created = createProposal({
          workspaceDir: opts.workspaceDir,
          targetRoot,
          name,
          contents: content,
          kind: "update",
          sourceSessionKey: opts.agentSessionKey,
          config: opts.config,
          agentId: opts.agentId,
        });
        if (!created.ok) {
          return err(action, created.errorCode, created.error, created.hint);
        }
        return jsonResult({
          status: "ok",
          action,
          persisted: false,
          proposalId: created.proposal.id,
          quality: created.quality,
          budgetPreview: created.budgetPreview,
        });
      }

      if (action === "patch") {
        const name = readStringParam(params, "name", { required: true });
        const oldString = readStringParam(params, "oldString", { required: true, trim: false });
        const newString = readStringParam(params, "newString", { required: true, trim: false });
        const targetRaw =
          readStringParam(params, "targetRoot") ?? readStringParam(params, "target");
        const targetRoot = parseTargetRoot(targetRaw) ?? "workspace";
        const replaceAll = params.replaceAll === true;
        if (!name || oldString === undefined || newString === undefined) {
          return err(
            action,
            "missing_argument",
            "name, oldString, and newString are required for patch",
          );
        }
        const disk = await readSkillMdFromDisk(opts.workspaceDir, name, targetRoot);
        if (!disk.ok) {
          return err(
            action,
            "skill_not_found",
            "skill not found on disk",
            "patch applies to on-disk SKILL.md only.",
          );
        }
        const applied = tryApplyPatch({ base: disk.content, oldString, newString, replaceAll });
        if (!applied.ok) {
          return err(
            action,
            applied.errorCode,
            applied.errorCode === "patch_no_match"
              ? "oldString not found in SKILL.md"
              : "oldString is ambiguous",
            applied.errorCode === "patch_ambiguous"
              ? "Use replaceAll or a longer unique oldString."
              : "Verify oldString matches disk file exactly.",
          );
        }
        const next = applied.next;
        const baseSkillHash = hashSkillFileContent(disk.content);
        const created = createProposal({
          workspaceDir: opts.workspaceDir,
          targetRoot,
          name,
          contents: next,
          kind: "patch",
          patch: { oldString, newString, replaceAll, baseSkillHash },
          sourceSessionKey: opts.agentSessionKey,
          config: opts.config,
          agentId: opts.agentId,
        });
        if (!created.ok) {
          return err(action, created.errorCode, created.error, created.hint);
        }
        return jsonResult({
          status: "ok",
          action,
          persisted: false,
          proposalId: created.proposal.id,
          budgetPreview: created.budgetPreview,
        });
      }

      return err(action, "invalid_action_arguments", `unsupported action: ${action}`);
    },
  };
}
