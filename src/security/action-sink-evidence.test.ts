import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseActionSinkEvidenceArtifact,
  verifyActionSinkEvidence,
  type ActionSinkEvidenceArtifact,
} from "./action-sink-evidence.js";

const repoRoot = process.cwd();
const branch = "agent/forge-mch-61-action-sink-policy-20260426-1940";
const commitSha = "4a3030df9efa72c44bab567a4390ac0c4876a73f";
const thisFile = fileURLToPath(import.meta.url);

function artifact(overrides: Partial<ActionSinkEvidenceArtifact> = {}): ActionSinkEvidenceArtifact {
  return {
    briefId: "MCH-61",
    repoRoot,
    branch,
    commitSha,
    review: { path: thisFile, result: "pass", timestamp: "2999-01-01T00:00:00.000Z" },
    qa: { path: thisFile, result: "pass", timestamp: "2999-01-01T00:00:00.000Z" },
    timestamp: "2999-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("action sink evidence", () => {
  it("validates a minimal good artifact and rejects missing required fields", () => {
    expect(parseActionSinkEvidenceArtifact(artifact()).briefId).toBe("MCH-61");
    expect(() => parseActionSinkEvidenceArtifact({})).toThrow(/missing/);
  });

  it("verifies git provenance and rejects fake/wrong branch evidence", () => {
    const result = verifyActionSinkEvidence(artifact(), { repoRoot, branch, commitSha });
    expect(result.ok).toBe(true);
    expect(
      verifyActionSinkEvidence(artifact({ branch: "main" }), { repoRoot, branch, commitSha }),
    ).toMatchObject({ ok: false });
    expect(fs.existsSync(repoRoot)).toBe(true);
  });

  it("rejects stale, fake, wrong-commit, and vague text artifacts", () => {
    expect(
      verifyActionSinkEvidence(artifact({ commitSha: "deadbeef" }), {
        repoRoot,
        branch,
        commitSha,
      }),
    ).toMatchObject({ ok: false });
    expect(
      verifyActionSinkEvidence(
        artifact({
          review: { path: thisFile, result: "pass", timestamp: "2000-01-01T00:00:00.000Z" },
        }),
        { repoRoot, branch, commitSha },
      ),
    ).toMatchObject({ ok: false });
    expect(() => parseActionSinkEvidenceArtifact("looks good")).toThrow();
  });
});
