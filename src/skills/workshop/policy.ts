// Workshop policy helpers validate generated skill drafts against workspace policy.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH } from "../../infra/plugin-approvals.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/hook-before-tool-call-result.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { computeSkillChangeSummary, resolvePendingSkillProposal } from "./service.js";

const SKILL_WORKSHOP_LIFECYCLE_ACTIONS = new Set(["apply", "reject", "quarantine"]);
// Codex dynamic tools have a 90s watchdog. Approval RPCs reserve another 10s
// for Gateway cleanup, leaving 10s for proposal lookup and tool-call overhead.
const SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS = 70_000;

type SkillWorkshopLifecycleAction = "apply" | "reject" | "quarantine";

// Only lifecycle actions mutate proposals and therefore require approval checks.
function readLifecycleAction(params: unknown): SkillWorkshopLifecycleAction | undefined {
  const action = asNullableRecord(params)?.action;
  if (typeof action !== "string" || !SKILL_WORKSHOP_LIFECYCLE_ACTIONS.has(action)) {
    return undefined;
  }
  return action as SkillWorkshopLifecycleAction;
}

function lifecycleApprovalText(action: SkillWorkshopLifecycleAction): {
  title: string;
  description: string;
  severity: "info" | "warning";
} {
  if (action === "apply") {
    return {
      title: "Apply workspace skill proposal",
      description: "Apply a pending workspace skill proposal into live workspace skills.",
      severity: "warning",
    };
  }
  if (action === "reject") {
    return {
      title: "Reject workspace skill proposal",
      description: "Reject a pending workspace skill proposal.",
      severity: "info",
    };
  }
  return {
    title: "Quarantine workspace skill proposal",
    description: "Quarantine a pending workspace skill proposal.",
    severity: "info",
  };
}

function readOptionalString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatBodySizeKb(content: string): string {
  return (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
}

function formatApprovalField(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"
      ? "↵"
      : "�",
  );
}

function buildLifecycleApprovalDescription(params: {
  proposalId: string;
  skillName: string;
  description: string;
  supportFileCount: number;
  bodySizeKb: string;
  changeSummary?: string;
}): string {
  const description = formatApprovalField(params.description);
  const requestedSkillName = formatApprovalField(params.skillName);
  const fixedLines = [
    `Proposal ID: ${params.proposalId}`,
    `Description: ${description}`,
    `Support files: ${params.supportFileCount}`,
    `Body size: ${params.bodySizeKb} KB`,
  ];
  if (params.changeSummary) {
    fixedLines.push(`Changes: ${params.changeSummary}`);
  }
  const skillPrefix = "Target skill: ";
  const fixedLength = fixedLines.join("\n").length + skillPrefix.length + fixedLines.length;
  const availableSkillNameLength = Math.max(
    1,
    PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH - fixedLength,
  );
  const skillName =
    requestedSkillName.length <= availableSkillNameLength
      ? requestedSkillName
      : `${truncateUtf16Safe(requestedSkillName, Math.max(0, availableSkillNameLength - 1))}…`;
  return [fixedLines[0], `${skillPrefix}${skillName}`, ...fixedLines.slice(1)].join("\n");
}

async function resolveLifecycleApprovalDescription(params: {
  toolParams: unknown;
  workspaceDir?: string;
  fallback: string;
}): Promise<{
  description: string;
  proposalId?: string;
  lowContinuity?: boolean;
}> {
  if (!params.workspaceDir) {
    return { description: params.fallback };
  }
  const toolParams = asNullableRecord(params.toolParams);
  try {
    const proposal = await resolvePendingSkillProposal({
      proposalId: readOptionalString(toolParams, "proposal_id"),
      name: readOptionalString(toolParams, "name"),
      workspaceDir: params.workspaceDir,
    });
    const record = proposal.record;
    let changeSummary: string | undefined;
    let lowContinuity = false;
    if (record.kind === "update" && toolParams?.action === "apply" && record.target.skillFile) {
      const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
      const proposedSkillContent = stripProposalFrontmatterForSkill(proposal.content);
      changeSummary = computeSkillChangeSummary(proposedSkillContent, currentContent);
      lowContinuity = isLowContinuityUpdate(proposedSkillContent, currentContent);
    }
    return {
      description: buildLifecycleApprovalDescription({
        proposalId: record.id,
        skillName: record.target.skillName,
        description: record.description,
        supportFileCount: record.supportFiles?.length ?? 0,
        bodySizeKb: formatBodySizeKb(proposal.content),
        changeSummary,
      }),
      proposalId: record.id,
      lowContinuity,
    };
  } catch {
    return { description: params.fallback };
  }
}

function lifecycleApprovalTimeoutReason(proposalId?: string): string {
  const proposal = proposalId ? `Proposal ${proposalId}` : "the proposal";
  return [
    "The Skill Workshop approval request expired without a decision.",
    `This lifecycle call left ${proposal} unchanged and pending; check its current status in case another operator acted on it.`,
    "Decide in the Skill Workshop UI or run `openclaw skills workshop apply|reject|quarantine <id>`.",
    "Do not retry this tool call in a loop.",
  ].join(" ");
}

function extractBodyLines(content: string): string[] {
  const frontmatterEnd = content.indexOf("---", content.indexOf("---") + 3);
  const body = frontmatterEnd >= 0 ? content.slice(frontmatterEnd + 3) : content;
  return body.split("\n").filter((line) => line.trim().length > 0);
}

function isLowContinuityUpdate(
  proposedSkillContent: string,
  currentContent: string | null,
): boolean {
  if (currentContent === null) {
    return false;
  }
  const proposedBody = extractBodyLines(proposedSkillContent);
  const currentBody = extractBodyLines(currentContent);
  if (proposedBody.length === 0 || currentBody.length === 0) {
    return false;
  }
  const proposedNonHeading = proposedBody.filter((line) => !/^#{1,6}\s+\S/u.test(line));
  const currentNonHeading = currentBody.filter((line) => !/^#{1,6}\s+\S/u.test(line));
  if (currentNonHeading.length === 0) {
    return proposedNonHeading.length === 0;
  }
  if (proposedNonHeading.length === 0) {
    return true;
  }
  const proposedSet = new Set(proposedNonHeading);
  let overlapCount = 0;
  for (const line of currentNonHeading) {
    if (proposedSet.has(line)) {
      overlapCount += 1;
    }
  }
  const ratio = overlapCount / currentNonHeading.length;
  return overlapCount < 3 || ratio < 0.5;
}

function resolveApprovalConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  if (config) {
    return config;
  }
  // Explicit hook config wins. Missing hook config may happen on agent paths;
  // unreadable runtime config cannot supply an explicit pending override.
  try {
    return getRuntimeConfig();
  } catch {
    return undefined;
  }
}

/** Returns approval policy for skill workshop lifecycle tool calls. */
export async function resolveSkillWorkshopToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PluginHookBeforeToolCallResult | undefined> {
  if (params.toolName !== "skill_workshop") {
    return undefined;
  }
  const action = readLifecycleAction(params.toolParams);
  if (!action) {
    return undefined;
  }
  const config = resolveSkillWorkshopConfig(resolveApprovalConfig(params.config));
  const approvalDescription = await resolveLifecycleApprovalDescription({
    toolParams: params.toolParams,
    workspaceDir: params.workspaceDir,
    fallback: lifecycleApprovalText(action).description,
  });
  if (config.approvalPolicy === "auto" && !approvalDescription.lowContinuity) {
    return undefined;
  }
  const text = lifecycleApprovalText(action);
  return {
    requireApproval: {
      ...text,
      description: approvalDescription.description,
      timeoutMs: SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS,
      timeoutReason: lifecycleApprovalTimeoutReason(approvalDescription.proposalId),
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
