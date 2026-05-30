import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import { scanSource } from "../security/scanner.js";
import {
  readProposalFrontmatter,
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "./frontmatter.js";
import {
  assertInsideWorkspace,
  createSkillProposalId,
  createSkillProposalRollback,
  hashSkillProposalContent,
  readSkillProposal,
  readSkillProposalManifest,
  readWorkspaceSkillFile,
  refreshSkillProposalManifest,
  resolveSkillProposalTarget,
  updateSkillProposalRecord,
  writeSkillProposal,
  writeSkillProposalRollback,
  writeWorkspaceSkillFile,
} from "./store.js";
import {
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalCreateInput,
  type SkillProposalManifest,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalScan,
  type SkillProposalUpdateInput,
} from "./types.js";

type SkillWorkshopWorkspaceOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);
const MAX_PROPOSAL_DRAFT_BYTES = 1024 * 1024;

export async function listSkillProposals(workspaceDir: string): Promise<SkillProposalManifest> {
  return await readSkillProposalManifest(workspaceDir);
}

export async function readSkillProposalDraftFile(filePath: string): Promise<string> {
  const read = await readLocalFileSafely({
    filePath,
    maxBytes: MAX_PROPOSAL_DRAFT_BYTES,
  });
  return read.buffer.toString("utf8");
}

export async function inspectSkillProposal(
  workspaceDir: string,
  proposalId: string,
): Promise<SkillProposalReadResult | null> {
  return await readSkillProposal(workspaceDir, proposalId);
}

export async function proposeCreateSkill(
  input: SkillProposalCreateInput,
): Promise<SkillProposalReadResult> {
  const name = normalizeRequired(input.name, "Skill name");
  const description = normalizeRequired(input.description, "Skill description");
  const target = resolveSkillProposalTarget({ workspaceDir: input.workspaceDir, skillName: name });
  if (await readWorkspaceSkillFile(target.skillFile)) {
    throw new Error(`Skill already exists at ${target.skillFile}.`);
  }

  const proposalContent = renderProposalMarkdown({
    name,
    description,
    content: input.content,
  });
  const now = new Date().toISOString();
  const id = createSkillProposalId(name);
  const goal = normalizeOptionalString(input.goal);
  const evidence = normalizeOptionalString(input.evidence);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "create",
    status: "pending",
    title: `Create ${name}`,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(proposalContent),
    target: {
      skillName: name,
      skillKey: target.skillKey,
      skillDir: target.skillDir,
      skillFile: target.skillFile,
      source: "openclaw-workspace",
    },
    scan: scanProposalContent(proposalContent),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({ workspaceDir: input.workspaceDir, record, content: proposalContent });
  return { record, content: proposalContent };
}

export async function proposeUpdateSkill(
  input: SkillProposalUpdateInput & SkillWorkshopWorkspaceOptions,
): Promise<SkillProposalReadResult> {
  const skillName = normalizeRequired(input.skillName, "Skill name");
  const status = await buildWorkspaceSkillStatus(input.workspaceDir, {
    config: input.config,
    agentId: input.agentId,
  });
  const targetSkill = resolveSkillStatusEntry(status.skills, skillName);
  if (!targetSkill) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  assertWritableSkillTarget(input.workspaceDir, targetSkill);
  const currentContent = await readWorkspaceSkillFile(targetSkill.filePath);
  if (currentContent === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }

  const proposalContent = renderProposalMarkdown({
    name: targetSkill.name,
    description: targetSkill.description,
    content: input.content,
  });
  const now = new Date().toISOString();
  const id = createSkillProposalId(targetSkill.skillKey || targetSkill.name);
  const goal = normalizeOptionalString(input.goal);
  const evidence = normalizeOptionalString(input.evidence);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "update",
    status: "pending",
    title: `Update ${targetSkill.name}`,
    description: targetSkill.description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(proposalContent),
    target: {
      skillName: targetSkill.name,
      skillKey: targetSkill.skillKey,
      skillDir: targetSkill.baseDir,
      skillFile: targetSkill.filePath,
      source: targetSkill.source,
      currentContentHash: hashSkillProposalContent(currentContent),
    },
    scan: scanProposalContent(proposalContent),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({ workspaceDir: input.workspaceDir, record, content: proposalContent });
  return { record, content: proposalContent };
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  const read = await readRequiredProposal(input.workspaceDir, input.proposalId);
  const now = new Date().toISOString();
  const record: SkillProposalRecord = {
    ...read.record,
    status: "quarantined",
    updatedAt: now,
    quarantinedAt: now,
    statusReason: normalizeOptionalString(input.reason),
    scan: {
      ...read.record.scan,
      state: "quarantined",
    },
  };
  await updateSkillProposalRecord({ workspaceDir: input.workspaceDir, record });
  return record;
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  const read = await readRequiredProposal(input.workspaceDir, input.proposalId);
  const { record, content } = read;
  if (record.status !== "pending") {
    throw new Error(`Only pending proposals can be applied. Current status: ${record.status}.`);
  }
  const draftHash = hashSkillProposalContent(content);
  if (draftHash !== record.draftHash) {
    throw new Error("Proposal draft changed without updating proposal metadata.");
  }
  const draftFrontmatter = readProposalFrontmatter(content);
  if (!draftFrontmatter) {
    throw new Error("Proposal draft must include proposal frontmatter.");
  }
  const scan = scanProposalContent(content);
  if (scan.state !== "clean") {
    const updated = {
      ...record,
      status: "quarantined" as const,
      updatedAt: new Date().toISOString(),
      quarantinedAt: new Date().toISOString(),
      scan: { ...scan, state: "quarantined" as const },
      statusReason: "Proposal scan failed.",
    };
    await updateSkillProposalRecord({ workspaceDir: input.workspaceDir, record: updated });
    throw new Error("Proposal scan failed; proposal was quarantined.");
  }

  assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
  assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
  const previousContent = await readWorkspaceSkillFile(record.target.skillFile);
  if (record.kind === "create" && previousContent !== null) {
    throw new Error(`Target skill already exists: ${record.target.skillFile}`);
  }
  if (record.kind === "update") {
    if (previousContent === null) {
      throw new Error(`Target skill is missing: ${record.target.skillFile}`);
    }
    if (
      record.target.currentContentHash &&
      hashSkillProposalContent(previousContent) !== record.target.currentContentHash
    ) {
      const stale = {
        ...record,
        status: "stale" as const,
        updatedAt: new Date().toISOString(),
        staleAt: new Date().toISOString(),
        statusReason: "Target skill changed after proposal creation.",
      };
      await updateSkillProposalRecord({ workspaceDir: input.workspaceDir, record: stale });
      throw new Error("Target skill changed after proposal creation; proposal marked stale.");
    }
  }

  const rollback = createSkillProposalRollback({
    proposalId: record.id,
    targetSkillFile: record.target.skillFile,
    action: record.kind,
    ...(previousContent !== null ? { previousContent } : {}),
  });
  await writeSkillProposalRollback({
    workspaceDir: input.workspaceDir,
    proposalId: record.id,
    rollback,
  });

  const skillContent = stripProposalFrontmatterForSkill(content);
  await writeWorkspaceSkillFile({
    workspaceDir: input.workspaceDir,
    filePath: record.target.skillFile,
    content: skillContent,
  });
  const now = new Date().toISOString();
  const applied: SkillProposalRecord = {
    ...record,
    status: "applied",
    updatedAt: now,
    appliedAt: now,
    scan,
  };
  await updateSkillProposalRecord({ workspaceDir: input.workspaceDir, record: applied });
  await refreshSkillProposalManifest(input.workspaceDir);
  return { record: applied, targetSkillFile: record.target.skillFile };
}

function scanProposalContent(content: string): SkillProposalScan {
  const scannedAt = new Date().toISOString();
  const findings = scanSource(content, "PROPOSAL.md");
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warn = findings.filter((finding) => finding.severity === "warn").length;
  const info = findings.filter((finding) => finding.severity === "info").length;
  return {
    state: critical > 0 ? "failed" : "clean",
    scannedAt,
    critical,
    warn,
    info,
    findings,
  };
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "rejected",
): Promise<SkillProposalRecord> {
  const read = await readRequiredProposal(input.workspaceDir, input.proposalId);
  const now = new Date().toISOString();
  const record: SkillProposalRecord = {
    ...read.record,
    status,
    updatedAt: now,
    rejectedAt: now,
    statusReason: normalizeOptionalString(input.reason),
  };
  await updateSkillProposalRecord({ workspaceDir: input.workspaceDir, record });
  return record;
}

async function readRequiredProposal(
  workspaceDir: string,
  proposalId: string,
): Promise<SkillProposalReadResult> {
  const read = await readSkillProposal(workspaceDir, proposalId);
  if (!read) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  return read;
}

function assertWritableSkillTarget(workspaceDir: string, skill: SkillStatusEntry): void {
  if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${skill.source}`);
  }
  assertInsideWorkspace(workspaceDir, skill.filePath, "skill file");
  assertInsideWorkspace(workspaceDir, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
