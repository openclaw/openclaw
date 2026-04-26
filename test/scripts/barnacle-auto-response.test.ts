import { describe, expect, it } from "vitest";
import {
  candidateLabels,
  classifyPullRequestCandidateLabels,
  managedLabelSpecs,
} from "../../scripts/github/barnacle-auto-response.mjs";

const blankTemplateBody = [
  "## Summary",
  "",
  "Describe the problem and fix in 2–5 bullets:",
  "",
  "- Problem:",
  "- Why it matters:",
  "- What changed:",
  "- What did NOT change (scope boundary):",
  "",
  "## Linked Issue/PR",
  "",
  "- Closes #",
  "- Related #",
  "",
  "## Root Cause (if applicable)",
  "",
  "- Root cause:",
  "",
  "## Regression Test Plan (if applicable)",
  "",
  "- Target test or file:",
].join("\n");

function pr(title: string, body = blankTemplateBody) {
  return {
    title,
    body,
  };
}

function file(filename: string, status = "modified") {
  return {
    filename,
    status,
  };
}

describe("barnacle-auto-response", () => {
  it("keeps Barnacle-owned labels documented and ClawHub spelled correctly", () => {
    expect(managedLabelSpecs["r: skill"].description).toContain("ClawHub");
    expect(managedLabelSpecs["r: skill"].description).not.toContain("Clawdhub");
    expect(managedLabelSpecs.dirty.description).toContain("dirty/unrelated");
    expect(managedLabelSpecs["r: support"].description).toContain("support requests");
    expect(managedLabelSpecs["r: third-party-extension"].description).toContain("ClawHub");
    expect(managedLabelSpecs["r: too-many-prs"].description).toContain("ten active PRs");

    for (const label of Object.values(candidateLabels)) {
      expect(managedLabelSpecs[label]).toBeDefined();
      expect(managedLabelSpecs[label].description).toMatch(/^Candidate:/);
    }
  });

  it("labels docs-only discoverability churn without closing it", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update README translation"), [
      file("README.md"),
    ]);

    expect(labels).toEqual(
      expect.arrayContaining([
        candidateLabels.blankTemplate,
        candidateLabels.lowSignalDocs,
        candidateLabels.docsDiscoverability,
      ]),
    );
  });

  it("does not treat template boilerplate as behavior evidence for test-only churn", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Add test coverage"), [
      file("src/gateway/foo.test.ts"),
    ]);

    expect(labels).toEqual(
      expect.arrayContaining([candidateLabels.blankTemplate, candidateLabels.testOnlyNoBug]),
    );
  });

  it("uses linked issues as context and suppresses low-signal docs labels", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr("Update docs", `${blankTemplateBody}\n\nRelated #12345`),
      [file("docs/plugins/community.md")],
    );

    expect(labels).not.toContain(candidateLabels.lowSignalDocs);
    expect(labels).not.toContain(candidateLabels.docsDiscoverability);
  });

  it("warns on broad high-surface PRs instead of auto-closing them as dirty", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Cleanup plugin docs"), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(labels).toContain(candidateLabels.dirtyCandidate);
  });

  it("suppresses dirty-candidate when the PR has concrete behavior context", () => {
    const body = [
      "- Problem: gateway crashes when plugin metadata is missing",
      "- Why it matters: users lose the running session",
      "- What changed: add a guard around metadata loading",
    ].join("\n");

    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway crash", body), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(labels).not.toContain(candidateLabels.dirtyCandidate);
  });
});
