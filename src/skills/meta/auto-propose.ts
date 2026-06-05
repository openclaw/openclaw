import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import { listSkillProposals, proposeCreateSkill, proposeUpdateSkill } from "../workshop/service.js";
import type { SkillProposalReadResult, SkillProposalSupportFileInput } from "../workshop/types.js";
import type { JsonRecord, MetaRunStore } from "./store.js";

export type MetaAutoProposeCandidate = {
  key: string;
  count: number;
  risk: "low" | "medium" | "high";
  hasOpenProposal: boolean;
  triggerCollision: boolean;
  liveSkillWritable?: boolean;
  liveSkillSource?: string;
};

export type MetaAutoProposeWorkflowCandidate = Omit<
  MetaAutoProposeCandidate,
  "hasOpenProposal" | "triggerCollision"
> & {
  name?: string;
  description: string;
  content: string;
  triggers?: string[];
  supportFiles?: SkillProposalSupportFileInput[];
  hasOpenProposal?: boolean;
  triggerCollision?: boolean;
};

export type MetaAutoProposeResult = {
  candidate: MetaAutoProposeWorkflowCandidate;
  proposal?: SkillProposalReadResult;
  skippedReason?: "not-selected" | "open-proposal" | "trigger-collision" | "non-writable-skill";
};

export type RunMetaAutoProposeOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  candidates: MetaAutoProposeWorkflowCandidate[];
  existingTriggers?: readonly string[];
  maxProposals?: number;
  agentId?: string;
  listSkillProposals?: typeof listSkillProposals;
  proposeCreateSkill?: typeof proposeCreateSkill;
  proposeUpdateSkill?: typeof proposeUpdateSkill;
};

export type BuildMetaAutoProposeCandidatesFromEvidenceOptions = {
  store: Pick<MetaRunStore, "listEvidenceByGate">;
  gateName?: string;
  limit?: number;
  minCount?: number;
};

type AutoProposeEvidenceCandidate = {
  key: string;
  name?: string;
  description: string;
  content: string;
  triggers: string[];
  count: number;
  risk: MetaAutoProposeWorkflowCandidate["risk"];
};

export const META_AUTO_PROPOSE_SIGNAL_GATE_NAME = "auto_propose_signal";
const AUTO_PROPOSE_WRITABLE_SKILL_SOURCES = new Set([
  "openclaw-workspace",
  "agents-skills-project",
]);

export function selectAutoProposeCandidates(
  candidates: MetaAutoProposeCandidate[],
): MetaAutoProposeCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.count >= 3 &&
        candidate.risk !== "high" &&
        !candidate.hasOpenProposal &&
        !candidate.triggerCollision &&
        candidate.liveSkillWritable !== false,
    )
    .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function normalizeTrigger(value: string): string {
  return value.trim().toLowerCase();
}

function readNonEmptyString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(record: JsonRecord, key: string): string[] {
  const value = record[key];
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readPositiveInteger(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readRisk(value: unknown): MetaAutoProposeWorkflowCandidate["risk"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function maxRisk(
  left: MetaAutoProposeWorkflowCandidate["risk"],
  right: MetaAutoProposeWorkflowCandidate["risk"],
): MetaAutoProposeWorkflowCandidate["risk"] {
  const rank = { low: 0, medium: 1, high: 2 } satisfies Record<
    MetaAutoProposeWorkflowCandidate["risk"],
    number
  >;
  return rank[right] > rank[left] ? right : left;
}

function parseAutoProposeSignal(
  evidenceJson: JsonRecord,
): AutoProposeEvidenceCandidate | undefined {
  const rawKey =
    readNonEmptyString(evidenceJson, "key") ??
    readNonEmptyString(evidenceJson, "workflowKey") ??
    readNonEmptyString(evidenceJson, "skillKey") ??
    readNonEmptyString(evidenceJson, "name");
  const key = rawKey ? normalizeSkillIndexName(rawKey) : "";
  const description = readNonEmptyString(evidenceJson, "description");
  const rawContent = evidenceJson.content;
  const content = typeof rawContent === "string" && rawContent.trim() ? rawContent : undefined;
  if (!key || !description || !content) {
    return undefined;
  }
  const name = readNonEmptyString(evidenceJson, "name");
  return {
    key,
    ...(name ? { name } : {}),
    description,
    content,
    triggers: [
      ...readStringList(evidenceJson, "triggers"),
      ...readStringList(evidenceJson, "trigger"),
    ],
    count: readPositiveInteger(evidenceJson, "count") ?? 1,
    risk: readRisk(evidenceJson.risk),
  };
}

export function buildMetaAutoProposeCandidatesFromEvidence(
  options: BuildMetaAutoProposeCandidatesFromEvidenceOptions,
): MetaAutoProposeWorkflowCandidate[] {
  const byKey = new Map<string, AutoProposeEvidenceCandidate>();
  for (const evidence of options.store.listEvidenceByGate(
    options.gateName ?? META_AUTO_PROPOSE_SIGNAL_GATE_NAME,
    options.limit,
  )) {
    const candidate = parseAutoProposeSignal(evidence.evidenceJson);
    if (!candidate) {
      continue;
    }
    const existing = byKey.get(candidate.key);
    if (!existing) {
      byKey.set(candidate.key, candidate);
      continue;
    }
    const triggers = new Set([...existing.triggers, ...candidate.triggers]);
    byKey.set(candidate.key, {
      ...existing,
      count: existing.count + candidate.count,
      risk: maxRisk(existing.risk, candidate.risk),
      triggers: [...triggers],
    });
  }

  const minCount = options.minCount ?? 1;
  return [...byKey.values()]
    .filter((candidate) => candidate.count >= minCount)
    .map((candidate) => {
      const proposal: MetaAutoProposeWorkflowCandidate = {
        key: candidate.key,
        description: candidate.description,
        content: candidate.content,
        count: candidate.count,
        risk: candidate.risk,
      };
      if (candidate.name) {
        proposal.name = candidate.name;
      }
      if (candidate.triggers.length > 0) {
        proposal.triggers = candidate.triggers;
      }
      return proposal;
    })
    .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function candidateName(candidate: MetaAutoProposeWorkflowCandidate): string {
  return candidate.name?.trim() || candidate.key;
}

function candidateSkillKey(candidate: MetaAutoProposeWorkflowCandidate): string {
  const skillKey = normalizeSkillIndexName(candidateName(candidate));
  if (!skillKey) {
    throw new Error(`Auto-propose candidate "${candidate.key}" does not resolve to a skill key.`);
  }
  return skillKey;
}

function hasTriggerCollision(
  candidate: MetaAutoProposeWorkflowCandidate,
  existingTriggers: ReadonlySet<string>,
): boolean {
  if (candidate.triggerCollision) {
    return true;
  }
  return (candidate.triggers ?? []).some((trigger) =>
    existingTriggers.has(normalizeTrigger(trigger)),
  );
}

function buildAutoProposeEvidence(candidate: MetaAutoProposeWorkflowCandidate): string {
  const triggers =
    candidate.triggers && candidate.triggers.length > 0
      ? ` triggers=${candidate.triggers.join(",")}`
      : "";
  return `auto-propose candidate key=${candidate.key} count=${candidate.count} risk=${candidate.risk}${triggers}`;
}

function resolveLiveSkill(params: {
  liveSkillsByName: ReadonlyMap<string, SkillStatusEntry>;
  candidate: MetaAutoProposeWorkflowCandidate;
}): SkillStatusEntry | undefined {
  return (
    params.liveSkillsByName.get(candidateName(params.candidate)) ??
    params.liveSkillsByName.get(candidateSkillKey(params.candidate))
  );
}

function isWritableLiveSkill(skill: SkillStatusEntry | undefined): boolean {
  return Boolean(skill && AUTO_PROPOSE_WRITABLE_SKILL_SOURCES.has(skill.source));
}

function buildLiveSkillsByName(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  candidates: readonly MetaAutoProposeWorkflowCandidate[];
}): Map<string, SkillStatusEntry> {
  const status = buildWorkspaceSkillStatus(params.workspaceDir, {
    ...(params.config ? { config: params.config } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const liveSkills = new Map<string, SkillStatusEntry>();
  for (const candidate of params.candidates) {
    const skill = resolveSkillStatusEntry(status.skills, candidateName(candidate));
    if (!skill) {
      continue;
    }
    liveSkills.set(candidateName(candidate), skill);
    liveSkills.set(candidateSkillKey(candidate), skill);
  }
  return liveSkills;
}

function candidateToSelectionInput(params: {
  candidate: MetaAutoProposeWorkflowCandidate;
  openProposalKeys: ReadonlySet<string>;
  existingTriggers: ReadonlySet<string>;
  liveSkill?: SkillStatusEntry;
}): MetaAutoProposeCandidate {
  return {
    key: params.candidate.key,
    count: params.candidate.count,
    risk: params.candidate.risk,
    hasOpenProposal:
      params.candidate.hasOpenProposal ??
      params.openProposalKeys.has(candidateSkillKey(params.candidate)),
    triggerCollision: hasTriggerCollision(params.candidate, params.existingTriggers),
    ...(params.liveSkill
      ? {
          liveSkillWritable: isWritableLiveSkill(params.liveSkill),
          liveSkillSource: params.liveSkill.source,
        }
      : {}),
  };
}

export async function runMetaAutoPropose(
  options: RunMetaAutoProposeOptions,
): Promise<MetaAutoProposeResult[]> {
  const listProposals = options.listSkillProposals ?? listSkillProposals;
  const proposeSkill = options.proposeCreateSkill ?? proposeCreateSkill;
  const proposeUpdate = options.proposeUpdateSkill ?? proposeUpdateSkill;
  const manifest = await listProposals({ workspaceDir: options.workspaceDir });
  const openProposalKeys = new Set(
    manifest.proposals
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => proposal.skillKey),
  );
  const existingTriggers = new Set((options.existingTriggers ?? []).map(normalizeTrigger));
  const liveSkillsByName = buildLiveSkillsByName({
    workspaceDir: options.workspaceDir,
    config: options.config,
    agentId: options.agentId,
    candidates: options.candidates,
  });
  const selected = new Set(
    selectAutoProposeCandidates(
      options.candidates.map((candidate) => {
        const liveSkill = resolveLiveSkill({
          liveSkillsByName,
          candidate,
        });
        return candidateToSelectionInput({
          candidate,
          openProposalKeys,
          existingTriggers,
          liveSkill,
        });
      }),
    )
      .slice(0, options.maxProposals ?? Number.POSITIVE_INFINITY)
      .map((candidate) => candidate.key),
  );

  const results: MetaAutoProposeResult[] = [];
  for (const candidate of options.candidates) {
    const skillKey = candidateSkillKey(candidate);
    const liveSkill = resolveLiveSkill({
      liveSkillsByName,
      candidate,
    });
    const liveSkillWritable = liveSkill ? isWritableLiveSkill(liveSkill) : undefined;
    const triggerCollision = hasTriggerCollision(candidate, existingTriggers);
    const hasOpenProposal = candidate.hasOpenProposal ?? openProposalKeys.has(skillKey);
    if (!selected.has(candidate.key)) {
      results.push({
        candidate,
        skippedReason: hasOpenProposal
          ? "open-proposal"
          : triggerCollision
            ? "trigger-collision"
            : liveSkillWritable === false
              ? "non-writable-skill"
              : "not-selected",
      });
      continue;
    }

    const commonProposalInput = {
      workspaceDir: options.workspaceDir,
      ...(options.config ? { config: options.config } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      description: candidate.description,
      content: candidate.content,
      ...(candidate.supportFiles ? { supportFiles: candidate.supportFiles } : {}),
      createdBy: "skill-workshop" as const,
      goal: `Auto-propose reusable workflow: ${candidate.key}`,
      evidence: buildAutoProposeEvidence(candidate),
    };
    const proposal = liveSkill
      ? await proposeUpdate({
          ...commonProposalInput,
          skillName: candidateName(candidate),
        })
      : await proposeSkill({
          ...commonProposalInput,
          name: candidateName(candidate),
        });
    openProposalKeys.add(proposal.record.target.skillKey);
    results.push({
      candidate,
      proposal,
    });
  }
  return results;
}
