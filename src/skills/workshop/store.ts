import crypto from "node:crypto";
import path from "node:path";
import { pathExists, readFileWithinRoot, root } from "../../infra/fs-safe.js";
import { tryReadJson } from "../../infra/json-files.js";
import { isPathInside } from "../../infra/path-safety.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  SKILL_WORKSHOP_MANIFEST_SCHEMA,
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalManifest,
  type SkillProposalManifestEntry,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "./types.js";

const WORKSHOP_REL_DIR = path.join(".openclaw", "skill-workshop");
const PROPOSALS_REL_DIR = path.join(WORKSHOP_REL_DIR, "proposals");
const MANIFEST_REL_PATH = path.join(WORKSHOP_REL_DIR, "proposals.json");
const PROPOSAL_RECORD_FILE = "proposal.json";
const PROPOSAL_DRAFT_FILE = "PROPOSAL.md";
const PROPOSAL_ROLLBACK_FILE = "rollback.json";
const MAX_PROPOSAL_BYTES = 1024 * 1024;
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;

export function createSkillProposalId(name: string, now = new Date()): string {
  const normalized = normalizeSkillIndexName(name) || "skill";
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `${normalized.slice(0, 60)}-${date}-${suffix}`;
}

export function hashSkillProposalContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function resolveWorkshopPath(workspaceDir: string): string {
  return path.resolve(workspaceDir, WORKSHOP_REL_DIR);
}

export function resolveProposalDir(workspaceDir: string, proposalId: string): string {
  assertProposalId(proposalId);
  return path.resolve(workspaceDir, proposalRelativeDir(proposalId));
}

export function resolveProposalRecordPath(workspaceDir: string, proposalId: string): string {
  return path.join(resolveProposalDir(workspaceDir, proposalId), PROPOSAL_RECORD_FILE);
}

export function resolveProposalDraftPath(workspaceDir: string, proposalId: string): string {
  return path.join(resolveProposalDir(workspaceDir, proposalId), PROPOSAL_DRAFT_FILE);
}

export function resolveSkillProposalTarget(params: { workspaceDir: string; skillName: string }): {
  skillKey: string;
  skillDir: string;
  skillFile: string;
} {
  const skillKey = normalizeSkillIndexName(params.skillName);
  if (!skillKey) {
    throw new Error("Skill name must contain at least one letter or number.");
  }
  const skillDir = path.resolve(params.workspaceDir, "skills", skillKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  assertInsideWorkspace(params.workspaceDir, skillDir, "skill directory");
  assertInsideWorkspace(params.workspaceDir, skillFile, "skill file");
  return { skillKey, skillDir, skillFile };
}

export async function readSkillProposal(
  workspaceDir: string,
  proposalId: string,
): Promise<SkillProposalReadResult | null> {
  const record = await readSkillProposalRecord(workspaceDir, proposalId);
  if (!record) {
    return null;
  }
  const workspaceRoot = await root(workspaceDir);
  const draft = await workspaceRoot.read(
    path.join(proposalRelativeDir(proposalId), PROPOSAL_DRAFT_FILE),
    {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_BYTES,
      symlinks: "reject",
    },
  );
  return { record, content: draft.buffer.toString("utf8") };
}

export async function readSkillProposalRecord(
  workspaceDir: string,
  proposalId: string,
): Promise<SkillProposalRecord | null> {
  const raw = await tryReadJson<unknown>(resolveProposalRecordPath(workspaceDir, proposalId));
  return parseSkillProposalRecord(raw);
}

export async function writeSkillProposal(params: {
  workspaceDir: string;
  record: SkillProposalRecord;
  content: string;
}): Promise<void> {
  assertProposalId(params.record.id);
  const workspaceRoot = await root(params.workspaceDir);
  const relativeDir = proposalRelativeDir(params.record.id);
  await workspaceRoot.mkdir(relativeDir);
  await workspaceRoot.write(path.join(relativeDir, PROPOSAL_DRAFT_FILE), params.content, {
    encoding: "utf8",
  });
  await workspaceRoot.writeJson(path.join(relativeDir, PROPOSAL_RECORD_FILE), params.record, {
    trailingNewline: true,
  });
  await refreshSkillProposalManifest(params.workspaceDir);
}

export async function updateSkillProposalRecord(params: {
  workspaceDir: string;
  record: SkillProposalRecord;
}): Promise<void> {
  assertProposalId(params.record.id);
  const workspaceRoot = await root(params.workspaceDir);
  await workspaceRoot.writeJson(
    path.join(proposalRelativeDir(params.record.id), PROPOSAL_RECORD_FILE),
    params.record,
    { trailingNewline: true },
  );
  await refreshSkillProposalManifest(params.workspaceDir);
}

export async function writeSkillProposalRollback(params: {
  workspaceDir: string;
  proposalId: string;
  rollback: SkillProposalRollback;
}): Promise<void> {
  const workspaceRoot = await root(params.workspaceDir);
  await workspaceRoot.writeJson(
    path.join(proposalRelativeDir(params.proposalId), PROPOSAL_ROLLBACK_FILE),
    params.rollback,
    { trailingNewline: true },
  );
}

export async function readSkillProposalManifest(
  workspaceDir: string,
): Promise<SkillProposalManifest> {
  const manifestPath = path.resolve(workspaceDir, MANIFEST_REL_PATH);
  const parsed = parseSkillProposalManifest(await tryReadJson<unknown>(manifestPath));
  if (parsed) {
    return parsed;
  }
  return await refreshSkillProposalManifest(workspaceDir);
}

export async function refreshSkillProposalManifest(
  workspaceDir: string,
): Promise<SkillProposalManifest> {
  const workspaceRoot = await root(workspaceDir);
  await workspaceRoot.mkdir(PROPOSALS_REL_DIR);
  const entries = await workspaceRoot.list(PROPOSALS_REL_DIR, { withFileTypes: true });
  const proposals: SkillProposalManifestEntry[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory || !PROPOSAL_ID_PATTERN.test(entry.name)) {
      continue;
    }
    const record = await readSkillProposalRecord(workspaceDir, entry.name);
    if (!record) {
      continue;
    }
    proposals.push(manifestEntryFromRecord(record));
  }

  const manifest: SkillProposalManifest = {
    schema: SKILL_WORKSHOP_MANIFEST_SCHEMA,
    updatedAt: new Date().toISOString(),
    proposals: proposals.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  await workspaceRoot.writeJson(MANIFEST_REL_PATH, manifest, {
    mkdir: true,
    trailingNewline: true,
  });
  return manifest;
}

export async function readWorkspaceSkillFile(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const read = await readFileWithinRoot({
    rootDir: path.dirname(filePath),
    relativePath: path.basename(filePath),
    maxBytes: MAX_PROPOSAL_BYTES,
  });
  return read.buffer.toString("utf8");
}

export async function writeWorkspaceSkillFile(params: {
  workspaceDir: string;
  filePath: string;
  content: string;
}): Promise<void> {
  assertInsideWorkspace(params.workspaceDir, params.filePath, "skill file");
  const relativePath = path.relative(
    path.resolve(params.workspaceDir),
    path.resolve(params.filePath),
  );
  const workspaceRoot = await root(params.workspaceDir);
  await workspaceRoot.write(relativePath, params.content, { encoding: "utf8", mkdir: true });
}

export function createSkillProposalRollback(params: {
  proposalId: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContent?: string;
}): SkillProposalRollback {
  return {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: params.proposalId,
    writtenAt: new Date().toISOString(),
    targetSkillFile: params.targetSkillFile,
    action: params.action,
    ...(params.previousContent !== undefined
      ? {
          previousContent: params.previousContent,
          previousContentHash: hashSkillProposalContent(params.previousContent),
        }
      : {}),
  };
}

export function assertInsideWorkspace(workspaceDir: string, targetPath: string, label: string) {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspaceDir &&
    !isPathInside(resolvedWorkspaceDir, resolvedTarget)
  ) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}

export function assertProposalId(proposalId: string): void {
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new Error("Invalid skill proposal id.");
  }
}

function manifestEntryFromRecord(record: SkillProposalRecord): SkillProposalManifestEntry {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    title: record.title,
    description: record.description,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    scanState: record.scan.state,
  };
}

function parseSkillProposalRecord(raw: unknown): SkillProposalRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as SkillProposalRecord;
  if (
    record.schema !== SKILL_WORKSHOP_SCHEMA ||
    !PROPOSAL_ID_PATTERN.test(record.id) ||
    (record.kind !== "create" && record.kind !== "update") ||
    !["pending", "applied", "rejected", "quarantined", "stale"].includes(record.status) ||
    typeof record.title !== "string" ||
    typeof record.description !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.draftHash !== "string" ||
    record.draftFile !== PROPOSAL_DRAFT_FILE ||
    !record.target ||
    typeof record.target !== "object" ||
    typeof record.target.skillName !== "string" ||
    typeof record.target.skillKey !== "string" ||
    typeof record.target.skillDir !== "string" ||
    typeof record.target.skillFile !== "string" ||
    !record.scan ||
    typeof record.scan !== "object"
  ) {
    return null;
  }
  return record;
}

function parseSkillProposalManifest(raw: unknown): SkillProposalManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const manifest = raw as SkillProposalManifest;
  if (
    manifest.schema !== SKILL_WORKSHOP_MANIFEST_SCHEMA ||
    typeof manifest.updatedAt !== "string" ||
    !Array.isArray(manifest.proposals)
  ) {
    return null;
  }
  const proposals = manifest.proposals.filter((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      PROPOSAL_ID_PATTERN.test(normalizeOptionalString(entry.id) ?? "") &&
      typeof entry.skillName === "string" &&
      typeof entry.skillKey === "string" &&
      typeof entry.updatedAt === "string"
    );
  });
  return { ...manifest, proposals };
}

function proposalRelativeDir(proposalId: string): string {
  assertProposalId(proposalId);
  return path.join(PROPOSALS_REL_DIR, proposalId);
}
