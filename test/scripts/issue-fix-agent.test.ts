// Issue Fix Agent tests cover local maintainer automation behavior.
import { describe, expect, it } from "vitest";
import {
  parseIssueFixAgentArgs,
  renderIssueFixAgentUsage,
} from "../../scripts/issue-fix-agent-main.ts";
import {
  classifyIssueCandidate,
  formatScanResult,
  sortQualifiedCandidates,
} from "../../scripts/issue-fix-agent-lib/candidates.ts";
import type { IssueCandidate } from "../../scripts/issue-fix-agent-lib/types.ts";

function issue(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    author: "external-user",
    body: "Repro: running openclaw status throws TypeError at src/commands/status.ts:12",
    isPullRequest: false,
    labels: ["bug"],
    number: 12345,
    title: "status crashes with TypeError",
    updatedAt: "2026-06-01T00:00:00Z",
    url: "https://github.com/openclaw/openclaw/issues/12345",
    ...overrides,
  };
}

describe("issue-fix-agent args", () => {
  it("parses scan without write flags", () => {
    expect(parseIssueFixAgentArgs(["scan"])).toStrictEqual({
      command: "scan",
      execute: false,
      pushPr: false,
      yes: false,
    });
  });

  it("requires --execute before --push-pr", () => {
    expect(() => parseIssueFixAgentArgs(["run", "--push-pr"])).toThrow(
      "--push-pr requires --execute",
    );
  });

  it("parses monitor with a PR number", () => {
    expect(parseIssueFixAgentArgs(["monitor", "12345"])).toStrictEqual({
      command: "monitor",
      execute: false,
      prNumber: 12345,
      pushPr: false,
      yes: false,
    });
  });

  it("renders usage with every first-version command", () => {
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent scan");
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent gc --dry-run");
  });
});

describe("issue-fix-agent candidates", () => {
  it("qualifies concrete narrow bug reports", () => {
    const result = classifyIssueCandidate(issue());
    expect(result.kind).toBe("qualified");
    if (result.kind === "qualified") {
      expect(result.candidate.score).toBeGreaterThan(0);
      expect(result.candidate.evidence).toContain("concrete symptom");
    }
  });

  it("skips pull requests and high-risk labels", () => {
    expect(classifyIssueCandidate(issue({ isPullRequest: true }))).toMatchObject({
      kind: "skipped",
      reason: "item is a pull request",
    });
    expect(classifyIssueCandidate(issue({ labels: ["security"] }))).toMatchObject({
      kind: "skipped",
      reason: "high-risk label: security",
    });
  });

  it("sorts qualified candidates by score then issue number", () => {
    const first = classifyIssueCandidate(
      issue({ labels: ["bug", "clawsweeper:source-repro"], number: 2 }),
    );
    const second = classifyIssueCandidate(issue({ number: 1 }));
    if (first.kind !== "qualified" || second.kind !== "qualified") {
      throw new Error("expected qualified candidates");
    }
    expect(sortQualifiedCandidates([second.candidate, first.candidate]).map((entry) => entry.number))
      .toEqual([2, 1]);
  });

  it("formats scan output with qualified and skipped rows", () => {
    const output = formatScanResult({
      qualified: [{ ...issue(), score: 5, evidence: ["concrete symptom"] }],
      skipped: [{ ...issue({ number: 99 }), reason: "high-risk label: security" }],
    });
    expect(output).toContain("#12345 status crashes with TypeError score=5");
    expect(output).toContain("skipped #99: high-risk label: security");
  });
});
