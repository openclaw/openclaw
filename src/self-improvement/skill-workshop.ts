import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeRecommendationText } from "./text.js";

export type SkillWorkshopProposalSnapshot = {
  id: string;
  status: "pending" | "quarantined" | "applied" | "rejected";
  title: string;
  skillName?: string;
  agentId?: string;
  sessionId?: string;
  workspaceDir?: string;
  reason?: string;
  quarantineReason?: string;
  createdAt?: number;
  updatedAt?: number;
  filePath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseProposal(value: unknown, filePath: string): SkillWorkshopProposalSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = sanitizeRecommendationText(value.id, 120);
  const status = sanitizeRecommendationText(value.status, 40);
  if (
    !id ||
    (status !== "pending" &&
      status !== "quarantined" &&
      status !== "applied" &&
      status !== "rejected")
  ) {
    return null;
  }
  const title =
    sanitizeRecommendationText(value.title, 160) ||
    sanitizeRecommendationText(value.skillName, 80) ||
    `Skill Workshop proposal ${id}`;
  return {
    id,
    status,
    title,
    skillName: sanitizeRecommendationText(value.skillName, 120) || undefined,
    agentId: sanitizeRecommendationText(value.agentId, 120) || undefined,
    sessionId: sanitizeRecommendationText(value.sessionId, 160) || undefined,
    workspaceDir: sanitizeRecommendationText(value.workspaceDir, 240) || undefined,
    reason: sanitizeRecommendationText(value.reason, 320) || undefined,
    quarantineReason: sanitizeRecommendationText(value.quarantineReason, 320) || undefined,
    createdAt: parseTimestamp(value.createdAt),
    updatedAt: parseTimestamp(value.updatedAt),
    filePath,
  };
}

function collectProposalCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  const proposals = value.proposals;
  if (Array.isArray(proposals)) {
    return proposals;
  }
  if (isRecord(proposals)) {
    return Object.values(proposals);
  }
  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

async function readProposalFile(filePath: string): Promise<SkillWorkshopProposalSnapshot[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return collectProposalCandidates(parsed)
      .map((candidate) => parseProposal(candidate, filePath))
      .filter((proposal): proposal is SkillWorkshopProposalSnapshot => Boolean(proposal));
  } catch {
    return [];
  }
}

export async function readSkillWorkshopProposalSnapshots(params: {
  stateDir: string;
}): Promise<SkillWorkshopProposalSnapshot[]> {
  const dir = path.join(params.stateDir, "skill-workshop");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(dir, entry));
  const proposals = await Promise.all(files.map((file) => readProposalFile(file)));
  return proposals.flat().toSorted((left, right) => left.id.localeCompare(right.id));
}
