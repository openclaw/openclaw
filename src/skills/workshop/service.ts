import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readLocalFileSafely, root, walkDirectory } from "../../infra/fs-safe.js";
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
  MAX_PROPOSAL_SUPPORT_FILE_BYTES,
  MAX_PROPOSAL_SUPPORT_FILES,
  normalizeSkillProposalSupportPath,
  prepareSkillProposalSupportFiles,
  readProposalSupportFiles,
  readSkillProposal,
  readSkillProposalManifest,
  readWorkspaceSupportFile,
  readWorkspaceSkillFile,
  replaceSkillProposalDraft,
  refreshSkillProposalManifest,
  resolveSkillProposalTarget,
  updateSkillProposalRecord,
  writeSkillProposal,
  writeSkillProposalRollback,
  writeWorkspaceSupportFile,
  writeWorkspaceSkillFile,
  type PreparedSkillProposalSupportFile,
} from "./store.js";
import {
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalCreateInput,
  type SkillProposalManifest,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalReviseInput,
  type SkillProposalScan,
  type SkillProposalSupportFileInput,
  type SkillProposalUpdateInput,
} from "./types.js";

type SkillWorkshopWorkspaceOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);
const MAX_PROPOSAL_DRAFT_BYTES = 1024 * 1024;
const MAX_PROPOSAL_DIRECTORY_ENTRIES = MAX_PROPOSAL_SUPPORT_FILES * 4;

export async function listSkillProposals(): Promise<SkillProposalManifest> {
  return await readSkillProposalManifest();
}

export async function readSkillProposalDraftFile(filePath: string): Promise<string> {
  const read = await readLocalFileSafely({
    filePath,
    maxBytes: MAX_PROPOSAL_DRAFT_BYTES,
  });
  return read.buffer.toString("utf8");
}

export async function readSkillProposalDraftDirectory(dirPath: string): Promise<{
  content: string;
  supportFiles: SkillProposalSupportFileInput[];
}> {
  const absoluteDir = path.resolve(dirPath);
  const draftRoot = await root(absoluteDir);
  const proposal = await draftRoot.read("PROPOSAL.md", {
    hardlinks: "reject",
    maxBytes: MAX_PROPOSAL_DRAFT_BYTES,
    symlinks: "reject",
  });
  const scanned = await walkDirectory(absoluteDir, {
    maxDepth: 8,
    maxEntries: MAX_PROPOSAL_DIRECTORY_ENTRIES,
    symlinks: "include",
  });
  if (scanned.truncated) {
    throw new Error("Proposal directory has too many entries.");
  }
  const supportFiles: SkillProposalSupportFileInput[] = [];
  for (const entry of scanned.entries.toSorted((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    const relativePath = toPortableRelativePath(entry.relativePath);
    if (!relativePath || relativePath === "PROPOSAL.md") {
      continue;
    }
    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`Proposal support file must be a regular file: ${relativePath}`);
    }
    const supportPath = normalizeSkillProposalSupportPath(relativePath);
    const read = await draftRoot.read(relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_SUPPORT_FILE_BYTES,
      symlinks: "reject",
    });
    supportFiles.push({ path: supportPath, content: read.buffer.toString("utf8") });
  }
  return {
    content: proposal.buffer.toString("utf8"),
    supportFiles,
  };
}

export async function inspectSkillProposal(
  proposalId: string,
): Promise<SkillProposalReadResult | null> {
  return await readSkillProposal(proposalId);
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

  const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
  const now = new Date().toISOString();
  const proposalContent = renderProposalMarkdown({
    name: target.skillKey,
    description,
    content: input.content,
    date: now,
  });
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
    scan: scanProposalBundle(proposalContent, supportFiles),
    ...(supportFiles.length > 0 ? { supportFiles: supportFileMetadata(supportFiles) } : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({ record, content: proposalContent, supportFiles });
  return { record, content: proposalContent };
}

export async function proposeUpdateSkill(
  input: SkillProposalUpdateInput & SkillWorkshopWorkspaceOptions,
): Promise<SkillProposalReadResult> {
  const skillName = normalizeRequired(input.skillName, "Skill name");
  const status = buildWorkspaceSkillStatus(input.workspaceDir, {
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

  const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
  const now = new Date().toISOString();
  const proposalContent = renderProposalMarkdown({
    name: targetSkill.skillKey,
    description: targetSkill.description,
    content: input.content,
    date: now,
  });
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
    scan: scanProposalBundle(proposalContent, supportFiles),
    ...(supportFiles.length > 0 ? { supportFiles: supportFileMetadata(supportFiles) } : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({ record, content: proposalContent, supportFiles });
  return { record, content: proposalContent };
}

export async function reviseSkillProposal(
  input: SkillProposalReviseInput,
): Promise<SkillProposalReadResult> {
  const read = await readRequiredProposal(input.proposalId);
  const { record } = read;
  if (record.status !== "pending") {
    throw new Error(`Only pending proposals can be revised. Current status: ${record.status}.`);
  }
  assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
  assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");

  if (record.kind === "create") {
    const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
    if (currentContent !== null) {
      await markProposalStale(record, "Target skill was created after proposal creation.");
      throw new Error("Target skill was created after proposal creation; proposal marked stale.");
    }
  } else {
    const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
    if (currentContent === null) {
      throw new Error(`Target skill is missing: ${record.target.skillFile}`);
    }
    if (
      record.target.currentContentHash &&
      hashSkillProposalContent(currentContent) !== record.target.currentContentHash
    ) {
      await markProposalStale(record, "Target skill changed after proposal creation.");
      throw new Error("Target skill changed after proposal creation; proposal marked stale.");
    }
  }

  const supportFiles =
    input.supportFiles === undefined
      ? await readProposalSupportFiles(record)
      : prepareSkillProposalSupportFiles(input.supportFiles);
  const nextVersion = nextProposalVersion(record.proposedVersion);
  const description = normalizeOptionalString(input.description) ?? record.description;
  const now = new Date().toISOString();
  const proposalContent = renderProposalMarkdown({
    name: record.target.skillKey,
    description,
    content: input.content,
    version: nextVersion,
    date: now,
  });
  const goal =
    input.goal === undefined
      ? normalizeOptionalString(record.goal)
      : normalizeOptionalString(input.goal);
  const evidence =
    input.evidence === undefined
      ? normalizeOptionalString(record.evidence)
      : normalizeOptionalString(input.evidence);
  const previousSupportFiles = record.supportFiles;
  const revised: SkillProposalRecord = {
    ...record,
    description,
    updatedAt: now,
    proposedVersion: nextVersion,
    draftHash: hashSkillProposalContent(proposalContent),
    scan: scanProposalBundle(proposalContent, supportFiles),
  };
  if (supportFiles.length > 0) {
    revised.supportFiles = supportFileMetadata(supportFiles);
  } else {
    delete revised.supportFiles;
  }
  if (goal) {
    revised.goal = goal;
  } else {
    delete revised.goal;
  }
  if (evidence) {
    revised.evidence = evidence;
  } else {
    delete revised.evidence;
  }
  await replaceSkillProposalDraft({
    record: revised,
    previousSupportFiles,
    content: proposalContent,
    supportFiles,
  });
  return { record: revised, content: proposalContent };
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  const read = await readRequiredProposal(input.proposalId);
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
  await updateSkillProposalRecord({ record });
  return record;
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  const read = await readRequiredProposal(input.proposalId);
  const { record, content } = read;
  if (record.status !== "pending") {
    throw new Error(`Only pending proposals can be applied. Current status: ${record.status}.`);
  }
  const draftHash = hashSkillProposalContent(content);
  if (draftHash !== record.draftHash) {
    throw new Error("Proposal draft changed without updating proposal metadata.");
  }
  const supportFiles = await readProposalSupportFiles(record);
  const draftFrontmatter = readProposalFrontmatter(content);
  if (!draftFrontmatter) {
    throw new Error("Proposal draft must include proposal frontmatter.");
  }
  const scan = scanProposalBundle(content, supportFiles);
  if (scan.state !== "clean") {
    const updated = {
      ...record,
      status: "quarantined" as const,
      updatedAt: new Date().toISOString(),
      quarantinedAt: new Date().toISOString(),
      scan: { ...scan, state: "quarantined" as const },
      statusReason: "Proposal scan failed.",
    };
    await updateSkillProposalRecord({ record: updated });
    throw new Error("Proposal scan failed; proposal was quarantined.");
  }

  assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
  assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
  const previousContent = await readWorkspaceSkillFile(record.target.skillFile);
  if (record.kind === "create" && previousContent !== null) {
    throw new Error(`Target skill already exists: ${record.target.skillFile}`);
  }
  const previousSupportFiles = [];
  for (const file of supportFiles) {
    const previousSupportContent = await readWorkspaceSupportFile({
      skillDir: record.target.skillDir,
      relativePath: file.path,
    });
    if (record.kind === "create" && previousSupportContent !== null) {
      throw new Error(
        `Target support file already exists: ${path.join(record.target.skillDir, file.path)}`,
      );
    }
    previousSupportFiles.push(
      previousSupportContent === null
        ? {
            path: file.path,
            existed: false,
          }
        : {
            path: file.path,
            existed: true,
            previousContent: previousSupportContent,
            previousContentHash: hashSkillProposalContent(previousSupportContent),
          },
    );
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
      await updateSkillProposalRecord({ record: stale });
      throw new Error("Target skill changed after proposal creation; proposal marked stale.");
    }
  }

  const rollback = createSkillProposalRollback({
    proposalId: record.id,
    targetSkillFile: record.target.skillFile,
    action: record.kind,
    ...(previousContent !== null ? { previousContent } : {}),
    ...(previousSupportFiles.length > 0 ? { supportFiles: previousSupportFiles } : {}),
  });
  await writeSkillProposalRollback({
    proposalId: record.id,
    rollback,
  });

  const skillContent = stripProposalFrontmatterForSkill(content);
  await writeWorkspaceSkillFile({
    workspaceDir: input.workspaceDir,
    filePath: record.target.skillFile,
    content: skillContent,
  });
  for (const file of supportFiles) {
    await writeWorkspaceSupportFile({
      skillDir: record.target.skillDir,
      relativePath: file.path,
      content: file.content,
    });
  }
  const now = new Date().toISOString();
  const applied: SkillProposalRecord = {
    ...record,
    status: "applied",
    updatedAt: now,
    appliedAt: now,
    scan,
  };
  await updateSkillProposalRecord({ record: applied });
  await refreshSkillProposalManifest();
  return { record: applied, targetSkillFile: record.target.skillFile };
}

function scanProposalBundle(
  content: string,
  supportFiles: readonly PreparedSkillProposalSupportFile[] = [],
): SkillProposalScan {
  const scannedAt = new Date().toISOString();
  const findings = [
    ...scanSource(content, "PROPOSAL.md"),
    ...supportFiles.flatMap((file) => scanSource(file.content, file.path)),
  ];
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

function supportFileMetadata(files: readonly PreparedSkillProposalSupportFile[]) {
  return files.map((file) => ({
    path: file.path,
    sizeBytes: file.sizeBytes,
    hash: file.hash,
  }));
}

function nextProposalVersion(version: string): string {
  const match = /^v(\d+)$/.exec(version.trim());
  if (!match) {
    return "v2";
  }
  const current = Number.parseInt(match[1] ?? "1", 10);
  return `v${Number.isSafeInteger(current) && current > 0 ? current + 1 : 2}`;
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "rejected",
): Promise<SkillProposalRecord> {
  const read = await readRequiredProposal(input.proposalId);
  const now = new Date().toISOString();
  const record: SkillProposalRecord = {
    ...read.record,
    status,
    updatedAt: now,
    rejectedAt: now,
    statusReason: normalizeOptionalString(input.reason),
  };
  await updateSkillProposalRecord({ record });
  return record;
}

async function readRequiredProposal(proposalId: string): Promise<SkillProposalReadResult> {
  const read = await readSkillProposal(proposalId);
  if (!read) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  return read;
}

async function markProposalStale(record: SkillProposalRecord, reason: string): Promise<void> {
  const stale = {
    ...record,
    status: "stale" as const,
    updatedAt: new Date().toISOString(),
    staleAt: new Date().toISOString(),
    statusReason: reason,
  };
  await updateSkillProposalRecord({ record: stale });
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

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}
