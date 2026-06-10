// Research autocapture helpers decide when skill research signals should be captured.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import { listSkillProposals, proposeCreateSkill, proposeUpdateSkill } from "../workshop/service.js";
import { resolveSkillProposalTarget } from "../workshop/store.js";
import { extractDurableInstructionProposal } from "./signals.js";

type SkillResearchAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillResearchAgentContext = {
  agentId?: string;
  workspaceDir?: string;
  trigger?: string;
  sessionKey?: string;
};

const log = createSubsystemLogger("skills/research");
const AUTOMATIC_CAPTURE_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);

function isHookScopedSessionKey(sessionKey: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (normalized.startsWith("hook:") || normalized.startsWith("cron:")) {
    return true;
  }
  return normalizeLowercaseStringOrEmpty(parseAgentSessionKey(sessionKey)?.rest).startsWith(
    "hook:",
  );
}

function isActiveMemoryHelperSessionKey(sessionKey: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  const agentSessionRest = normalizeLowercaseStringOrEmpty(parseAgentSessionKey(sessionKey)?.rest);
  return (
    normalized.startsWith("active-memory-") ||
    normalized.includes(":active-memory:") ||
    agentSessionRest.startsWith("active-memory-")
  );
}

function shouldSkipSkillResearchAutoCapture(ctx: SkillResearchAgentContext): boolean {
  const trigger = normalizeLowercaseStringOrEmpty(ctx.trigger);
  if (AUTOMATIC_CAPTURE_TRIGGERS.has(trigger)) {
    return true;
  }
  return (
    isCronSessionKey(ctx.sessionKey) ||
    isSubagentSessionKey(ctx.sessionKey) ||
    isHookScopedSessionKey(ctx.sessionKey) ||
    isActiveMemoryHelperSessionKey(ctx.sessionKey)
  );
}

// Captured updates append below existing skill text so learned context stays auditable.
function buildAutoCaptureUpdateContent(existingSkill: string, capturedContent: string): string {
  return [existingSkill.trimEnd(), "", "## Captured Update", "", capturedContent.trim(), ""].join(
    "\n",
  );
}

/** Captures durable skill research signals from a session transcript when enabled. */
export async function runSkillResearchAutoCapture(params: {
  event: SkillResearchAgentEndEvent;
  ctx: SkillResearchAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const workshopConfig = resolveSkillWorkshopConfig(params.config);
  if (!workshopConfig.autonomous.enabled) {
    return;
  }
  if (params.event.success === false) {
    return;
  }
  if (shouldSkipSkillResearchAutoCapture(params.ctx)) {
    return;
  }
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }

  const proposal = extractDurableInstructionProposal({ messages: params.event.messages });
  if (!proposal) {
    return;
  }

  const manifest = await listSkillProposals({ workspaceDir });
  if (
    manifest.proposals.some(
      (entry) =>
        (entry.status === "pending" || entry.status === "quarantined") &&
        entry.skillKey === proposal.skillName,
    )
  ) {
    return;
  }

  try {
    const target = resolveSkillProposalTarget({
      workspaceDir,
      skillName: proposal.skillName,
    });
    const existingSkill = await readWorkspaceSkillFile(target.skillFile);
    const result =
      existingSkill === null
        ? await proposeCreateSkill({
            workspaceDir,
            config: params.config,
            name: proposal.skillName,
            description: proposal.description,
            content: proposal.content,
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          })
        : await proposeUpdateSkill({
            workspaceDir,
            config: params.config,
            agentId: params.ctx.agentId,
            skillName: proposal.skillName,
            description: proposal.description,
            content: buildAutoCaptureUpdateContent(existingSkill, proposal.content),
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          });
    log.info(
      `skill research auto-capture queued workshop proposal ${result.record.target.skillKey}`,
    );
  } catch (error) {
    log.warn(`skill research auto-capture skipped: ${String(error)}`);
  }
}
