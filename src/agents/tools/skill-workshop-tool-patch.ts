import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { hasRunWorkspaceSkillUsage } from "../../skills/runtime/run-usage.js";
import { stripProposalFrontmatterForSkill } from "../../skills/workshop/frontmatter.js";
import { findUniqueSkillPatchSpan } from "../../skills/workshop/service.js";
import type { SkillWorkshopPreparedPatch } from "../../skills/workshop/types.js";
import { readWritableWorkshopSkill } from "../../skills/workshop/workspace-skill-read.js";
import { readToolStringParam, ToolInputError } from "./common.js";
import { textResult } from "./tool-results.js";

type WritableSkillPatchTarget = Awaited<ReturnType<typeof readWritableWorkshopSkill>>;

const PATCH_CONTEXT_PREFIX = [
  "Prepared patch context. This is a bounded excerpt, not the complete skill.",
  "Only the exact text under authorized old_string may be replaced by the next patch call.",
].join("\n");

export function readSkillPatchText(params: Record<string, unknown>) {
  return {
    oldString:
      readToolStringParam(params, "old_string", { label: "old_string", trim: false }) ?? "",
    newString: readToolStringParam(params, "new_string", {
      required: true,
      label: "new_string",
      trim: false,
    }),
  };
}

export async function executePrepareSkillPatch(params: {
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  toolParams: Record<string, unknown>;
  preparedSkillPatches: Map<string, SkillWorkshopPreparedPatch>;
  proposalMutationBudgetRemaining?: number;
  maxChars: number;
}) {
  if (
    params.proposalMutationBudgetRemaining !== undefined &&
    params.proposalMutationBudgetRemaining <= 0
  ) {
    throw new ToolInputError("this Skill Workshop session has reached its proposal mutation limit");
  }
  const skill = await readWritableWorkshopSkill(
    readToolStringParam(params.toolParams, "skill_name", {
      required: true,
      label: "skill_name",
    }),
    { config: params.config, agentId: params.agentId, env: params.env },
  );
  if (params.preparedSkillPatches.has(skill.skillKey)) {
    throw new ToolInputError(
      `skill "${skill.skillName}" already has a prepared patch: call action=patch to redeem or invalidate it before preparing another exact span`,
    );
  }
  try {
    const oldString = readToolStringParam(params.toolParams, "old_string", {
      required: true,
      label: "old_string",
      trim: false,
    });
    const body = stripProposalFrontmatterForSkill(skill.content);
    const span = findUniqueSkillPatchSpan(body, oldString);
    const sizeBytes = Buffer.byteLength(skill.content);
    const heading = [
      `Skill: ${skill.skillName} (${sizeBytes} bytes)`,
      PATCH_CONTEXT_PREFIX,
      "--- bounded context before target ---",
    ].join("\n");
    const target = [
      "--- authorized old_string ---",
      oldString,
      "--- bounded context after target ---",
    ].join("\n");
    const remaining = params.maxChars - heading.length - target.length - 3;
    if (remaining < 0) {
      throw new Error(
        "old_string is too large for the selected-model patch context; quote a shorter unique span",
      );
    }
    const beforeBudget = Math.floor(remaining / 2);
    const afterBudget = remaining - beforeBudget;
    const before = sliceUtf16Safe(body, Math.max(0, span.start - beforeBudget), span.start);
    const after = sliceUtf16Safe(body, span.end, span.end + afterBudget);
    const text = [heading, before, target, after].join("\n");
    params.preparedSkillPatches.set(skill.skillKey, {
      skillFile: skill.skillFile,
      contentHash: sha256Hex(skill.content),
      oldString,
    });
    return textResult(text, {
      skillName: skill.skillName,
      skillKey: skill.skillKey,
      sizeBytes,
      patchPrepared: true,
    });
  } catch (error) {
    params.preparedSkillPatches.delete(skill.skillKey);
    throw new ToolInputError(error instanceof Error ? error.message : String(error));
  }
}

export function resolveSkillPatchAuthorization(params: {
  skill: WritableSkillPatchTarget;
  oldString: string;
  readHash: string | undefined;
  preparedSkillPatches: Map<string, SkillWorkshopPreparedPatch>;
}): string | undefined {
  if (params.readHash) {
    params.preparedSkillPatches.delete(params.skill.skillKey);
    return params.readHash;
  }
  const prepared = params.preparedSkillPatches.get(params.skill.skillKey);
  if (!prepared) {
    return undefined;
  }
  params.preparedSkillPatches.delete(params.skill.skillKey);
  if (
    prepared.skillFile !== params.skill.skillFile ||
    prepared.contentHash !== sha256Hex(params.skill.content)
  ) {
    throw new ToolInputError(
      `skill "${params.skill.skillName}" changed since the patch was prepared: call action=prepare_patch again with the current exact old_string`,
    );
  }
  if (prepared.oldString !== params.oldString) {
    throw new ToolInputError(
      "patch old_string differs from the prepared exact span: call action=prepare_patch again for this old_string",
    );
  }
  return prepared.contentHash;
}

export function assertSkillPatchRunUsage(params: {
  skill: WritableSkillPatchTarget;
  foregroundRepair: boolean;
  runId?: string;
}): void {
  if (
    params.foregroundRepair &&
    !hasRunWorkspaceSkillUsage({
      runId: params.runId,
      name: params.skill.skillKey,
      skillFile: params.skill.skillFile,
    })
  ) {
    throw new ToolInputError(
      `skill "${params.skill.skillName}" was not used in this run and cannot be repaired autonomously`,
    );
  }
}
