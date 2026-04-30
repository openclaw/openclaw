import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type ActionSinkEvidenceArtifact = {
  briefId: string;
  repoRoot: string;
  branch: string;
  commitSha?: string;
  commitRange?: string;
  review: { path: string; result: "pass" | "fail"; timestamp: string };
  qa: { path: string; result: "pass" | "fail"; timestamp: string };
  timestamp: string;
};

export type EvidenceVerificationResult = { ok: true } | { ok: false; reason: string };

export function parseActionSinkEvidenceArtifact(value: unknown): ActionSinkEvidenceArtifact {
  if (!value || typeof value !== "object") {
    throw new Error("evidence artifact must be an object");
  }
  const artifact = value as Partial<ActionSinkEvidenceArtifact>;
  for (const field of ["briefId", "repoRoot", "branch", "timestamp"] as const) {
    if (typeof artifact[field] !== "string" || !artifact[field]) {
      throw new Error(`evidence missing ${field}`);
    }
  }
  if (!artifact.commitSha && !artifact.commitRange) {
    throw new Error("evidence missing commitSha or commitRange");
  }
  for (const field of ["review", "qa"] as const) {
    const item = artifact[field];
    if (
      !item ||
      typeof item.path !== "string" ||
      item.result !== "pass" ||
      typeof item.timestamp !== "string"
    ) {
      throw new Error(`evidence ${field} must have path, pass result, and timestamp`);
    }
  }
  return artifact as ActionSinkEvidenceArtifact;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyActionSinkEvidence(
  artifact: ActionSinkEvidenceArtifact,
  expected: {
    repoRoot: string;
    branch: string;
    commitSha?: string;
    commitRange?: string;
    now?: Date;
  },
): EvidenceVerificationResult {
  try {
    parseActionSinkEvidenceArtifact(artifact);
    if (!fs.existsSync(artifact.repoRoot) || artifact.repoRoot !== expected.repoRoot) {
      return { ok: false, reason: "wrong repo root" };
    }
    if (artifact.branch !== expected.branch) {
      return { ok: false, reason: "wrong branch" };
    }
    if (expected.commitSha && artifact.commitSha !== expected.commitSha) {
      return { ok: false, reason: "wrong commit" };
    }
    if (expected.commitRange && artifact.commitRange !== expected.commitRange) {
      return { ok: false, reason: "wrong commit range" };
    }
    const currentBranch = git(artifact.repoRoot, ["branch", "--show-current"]);
    if (currentBranch !== artifact.branch) {
      return { ok: false, reason: "branch does not match repo" };
    }
    const sha = artifact.commitSha ?? artifact.commitRange?.split("..").pop();
    if (sha) {
      git(artifact.repoRoot, ["cat-file", "-e", `${sha}^{commit}`]);
    }
    const commitTime = sha
      ? new Date(git(artifact.repoRoot, ["show", "-s", "--format=%cI", sha])).getTime()
      : 0;
    const reviewTime = Date.parse(artifact.review.timestamp);
    const qaTime = Date.parse(artifact.qa.timestamp);
    if (
      !Number.isFinite(reviewTime) ||
      !Number.isFinite(qaTime) ||
      reviewTime < commitTime ||
      qaTime < commitTime
    ) {
      return { ok: false, reason: "stale evidence" };
    }
    if (!fs.existsSync(artifact.review.path) || !fs.existsSync(artifact.qa.path)) {
      return { ok: false, reason: "evidence file missing" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
