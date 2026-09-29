import { describe, expect, it } from "vitest";
import {
  CONVERGENCE_DECISIONS,
  EVIDENCE_SURFACES,
  auditPrConvergence,
  decidePrConvergence,
  extractFindingsFromEvidenceItem,
  normalizeIssueComment,
} from "../../scripts/pr-convergence-audit.mjs";

const repo = "openclaw/openclaw";
const pr = 113641;
const headSha = "aabbccddaabbccddaabbccddaabbccddaabbccdd";
const staleSha = "1111111111111111111111111111111111111111";
const prUrl = `https://github.com/${repo}/pull/${pr}`;

type ProviderOptions = {
  formalReviews?: Record<string, unknown>[];
  inlineReviewComments?: Record<string, unknown>[];
  issueComments?: Record<string, unknown>[];
  requestedReviewers?: string[];
  checkRuns?: Record<string, unknown>[];
  requiredCheckPolicy?: "resolved" | "unknown";
  completeness?: Partial<Record<string, boolean>>;
  headShaInitial?: string;
  headShaFinal?: string;
  prLastEditedAtInitial?: string | null;
  prLastEditedAtFinal?: string | null;
  prTitleInitial?: string;
  prTitleFinal?: string;
  prTitleEditedAtInitial?: string | null;
  prTitleEditedAtFinal?: string | null;
  prBaseEditedAtInitial?: string | null;
  prBaseEditedAtFinal?: string | null;
  baseRefInitial?: string;
  baseRefFinal?: string;
  prStateInitial?: string;
  prStateFinal?: string;
  draftInitial?: boolean;
  draftFinal?: boolean;
  prAuthor?: string;
};

function successfulCheck(name: string, id: number) {
  return {
    id: String(id),
    name,
    status: "completed",
    conclusion: "success",
    headSha,
    url: `https://github.com/${repo}/actions/runs/${id}`,
    required: true,
  };
}

function clawsweeperComment(params: {
  id: number;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}) {
  return {
    id: params.id,
    html_url: `${prUrl}#issuecomment-${params.id}`,
    created_at: params.createdAt ?? "2026-07-26T09:00:00Z",
    updated_at: params.updatedAt ?? params.createdAt ?? "2026-07-26T09:00:00Z",
    user: {
      login: "clawsweeper[bot]",
      type: "Bot",
    },
    performed_via_github_app: {
      slug: "clawsweeper",
    },
    body: params.body,
  };
}

function createProvider(options: ProviderOptions = {}) {
  const initialHead = options.headShaInitial ?? headSha;
  const finalHead = options.headShaFinal ?? initialHead;
  let pullReads = 0;
  const completeness = {
    formal_reviews: true,
    inline_review_comments: true,
    issue_comments: true,
    requested_reviewers: true,
    check_runs: true,
    ...options.completeness,
  };

  return {
    provider: {
      async fetchPullRequest() {
        pullReads += 1;
        return {
          number: pr,
          html_url: prUrl,
          head: {
            sha: pullReads === 1 ? initialHead : finalHead,
            ref: "codex/pr-convergence-audit",
          },
          base: {
            ref:
              pullReads === 1
                ? (options.baseRefInitial ?? "main")
                : (options.baseRefFinal ?? options.baseRefInitial ?? "main"),
          },
          state:
            pullReads === 1
              ? (options.prStateInitial ?? "OPEN")
              : (options.prStateFinal ?? options.prStateInitial ?? "OPEN"),
          draft:
            pullReads === 1
              ? (options.draftInitial ?? false)
              : (options.draftFinal ?? options.draftInitial ?? false),
          title:
            pullReads === 1
              ? (options.prTitleInitial ?? "Audit PR convergence")
              : (options.prTitleFinal ?? options.prTitleInitial ?? "Audit PR convergence"),
          last_edited_at:
            pullReads === 1
              ? (options.prLastEditedAtInitial ?? null)
              : (options.prLastEditedAtFinal ?? options.prLastEditedAtInitial ?? null),
          title_edited_at:
            pullReads === 1
              ? (options.prTitleEditedAtInitial ?? null)
              : (options.prTitleEditedAtFinal ?? options.prTitleEditedAtInitial ?? null),
          base_edited_at:
            pullReads === 1
              ? (options.prBaseEditedAtInitial ?? null)
              : (options.prBaseEditedAtFinal ?? options.prBaseEditedAtInitial ?? null),
          user: { login: options.prAuthor ?? "pr-author" },
        };
      },
      async fetchFormalReviews() {
        return {
          items: options.formalReviews ?? [],
          complete: completeness.formal_reviews,
        };
      },
      async fetchInlineReviewComments() {
        return {
          items: options.inlineReviewComments ?? [],
          complete: completeness.inline_review_comments,
        };
      },
      async fetchIssueComments() {
        return {
          items: options.issueComments ?? [],
          complete: completeness.issue_comments,
        };
      },
      async fetchRequestedReviewers() {
        return {
          logins: options.requestedReviewers ?? [],
          complete: completeness.requested_reviewers,
        };
      },
      async fetchCheckRuns() {
        return {
          items: options.checkRuns ?? [
            successfulCheck("CI", 1),
            successfulCheck("Workflow Sanity", 2),
          ],
          complete: completeness.check_runs,
          requiredPolicy: options.requiredCheckPolicy ?? "resolved",
        };
      },
    },
    getPullReads: () => pullReads,
  };
}

describe("pr-convergence-audit", () => {
  it("detects BLOCKED from an exact-head ClawSweeper issue comment when formal reviews are empty", async () => {
    const blockerBody = [
      "## ClawSweeper review",
      "",
      "P0: Missing focused regression proof for the changed gateway path.",
      "",
      "BLOCKED until the proof gap is closed.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9001,
          body: blockerBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.headSha).toBe(headSha);
    expect(result.prUrl).toBe(prUrl);
    expect(result.evidence.formalReviews).toEqual([]);
    expect(result.evidence.issueComments).toHaveLength(1);
    expect(result.evidence.issueComments[0]?.surface).toBe(EVIDENCE_SURFACES.ISSUE_COMMENT);
    expect(result.evidence.issueComments[0]?.reviewedSha).toBe(headSha);
    expect(result.findingCounts.p0).toBe(1);
    expect(result.findingCounts.blocked).toBe(1);
    expect(result.findings.some((finding) => finding.currentHead && finding.blocking)).toBe(true);
    expect(result.findings[0]?.sourceUrl).toBe(`${prUrl}#issuecomment-9001`);
    expect(result.nextAction).toContain("blocking findings");
  });

  it("returns UNKNOWN for a stale-head ClawSweeper blocker instead of silently dismissing it", async () => {
    const blockerBody = [
      "P1: Proof is stale for the previous head.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${staleSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9002,
          body: blockerBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.headSha).toBe(headSha);
    expect(result.findings.some((finding) => finding.blocking && !finding.currentHead)).toBe(true);
    expect(result.reason).toContain("Stale blocking review evidence");
    expect(result.nextAction).toMatch(/re-review/i);
  });

  it("ignores clean non-review contributor comments", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9100,
          html_url: `${prUrl}#issuecomment-9100`,
          created_at: "2026-07-26T08:00:00Z",
          user: { login: "contributor", type: "User" },
          body: "Thanks for the quick review!",
        },
        clawsweeperComment({
          id: 9101,
          body: passBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({});
    expect(result.evidence.issueComments).toHaveLength(2);
    expect(result.reason).toContain("no unresolved blockers");
  });

  it("does not trust forged ClawSweeper verdict markers from ordinary commenters", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9102,
          html_url: `${prUrl}#issuecomment-9102`,
          created_at: "2026-07-26T08:05:00Z",
          user: { login: "contributor", type: "User" },
          body: `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.evidence.issueComments[0]?.reviewedSha).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it.each([
    "No actionable findings.",
    "No P1 findings remain.",
    "Actionable findings: 0",
    "Actionable findings: **0**",
    "P0: 0, P1: 0, P2: 0",
    "The exact-head review is not BLOCKED.",
  ])("does not create blockers from negated review prose: %s", (body) => {
    const findings = extractFindingsFromEvidenceItem(
      {
        id: "negated",
        surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
        url: `${prUrl}#pullrequestreview-negated`,
        author: "maintainer",
        createdAt: "2026-07-26T09:00:00Z",
        effectiveAt: "2026-07-26T09:00:00Z",
        body,
        reviewState: "COMMENTED",
        reviewedSha: headSha,
        commitId: headSha,
      },
      headSha,
    );

    expect(findings).toEqual([]);
  });

  it("does not misread a do-not-merge instruction as a negated P1", () => {
    const item = {
      id: "active-p1",
      surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
      url: `${prUrl}#pullrequestreview-active-p1`,
      author: "maintainer",
      createdAt: "2026-07-26T09:00:00Z",
      effectiveAt: "2026-07-26T09:00:00Z",
      body: "Do not merge until P1 is fixed.",
      reviewState: "CHANGES_REQUESTED",
      reviewedSha: headSha,
      commitId: headSha,
    };

    expect(extractFindingsFromEvidenceItem(item, headSha)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "p1", currentHead: true })]),
    );
  });

  it.each(["P1: False success when an upload fails", "P1: Fixed-size buffer overflows"])(
    "does not interpret a finding title as resolved: %s",
    (body) => {
      const findings = extractFindingsFromEvidenceItem(
        {
          id: "finding-title",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-finding-title`,
          author: "maintainer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
          body,
          reviewState: "COMMENTED",
          reviewedSha: headSha,
          commitId: headSha,
        },
        headSha,
      );

      expect(findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "p1", currentHead: true })]),
      );
    },
  );

  it.each(["No P0/P1/P2 findings.", "No **P0**/**P1**/**P2** findings.", "**P1**: 0"])(
    "recognizes negated severity lists and Markdown formatting: %s",
    (body) => {
      const findings = extractFindingsFromEvidenceItem(
        {
          id: "formatted-negation",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-formatted-negation`,
          author: "maintainer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
          body,
          reviewState: "COMMENTED",
          reviewedSha: headSha,
          commitId: headSha,
        },
        headSha,
      );

      expect(findings).toEqual([]);
    },
  );

  it("retains a BLOCKED finding from an authenticated repository actor", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({ id: 9107, body: passBody }),
        {
          id: 9108,
          html_url: `${prUrl}#issuecomment-9108`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "BLOCKED: authentication bypass remains.",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "blocked", currentHead: true })]),
    );
  });

  it("retains an unresolved BLOCKED inline thread from an authenticated reviewer", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      inlineReviewComments: [
        {
          id: 9112,
          html_url: `${prUrl}#discussion_r9112`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: "BLOCKED: authentication bypass remains.",
          commit_id: headSha,
          thread_resolved: false,
        },
      ],
      issueComments: [clawsweeperComment({ id: 9113, body: passBody })],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "blocked", currentHead: true })]),
    );
  });

  it("preserves a resolved inline thread as evidence without keeping its finding active", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      inlineReviewComments: [
        {
          id: 9114,
          html_url: `${prUrl}#discussion_r9114`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: "P1: Historical finding in a resolved thread.",
          commit_id: headSha,
          thread_resolved: true,
        },
      ],
      issueComments: [clawsweeperComment({ id: 9115, body: passBody })],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.inlineReviewComments).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it("uses only the latest decisive formal review from each reviewer", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      formalReviews: [
        {
          id: 100,
          html_url: `${prUrl}#pullrequestreview-100`,
          submitted_at: "2026-07-26T09:00:00Z",
          user: { login: "reviewer" },
          body: "P1: Fix the unsafe path.",
          state: "CHANGES_REQUESTED",
          commit_id: headSha,
        },
        {
          id: 101,
          html_url: `${prUrl}#pullrequestreview-101`,
          submitted_at: "2026-07-26T09:05:00Z",
          user: { login: "reviewer" },
          body: "The requested change is resolved.",
          state: "APPROVED",
          commit_id: headSha,
        },
      ],
      issueComments: [
        clawsweeperComment({
          id: 9109,
          body: passBody,
          updatedAt: "2026-07-26T09:06:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.formalReviews).toHaveLength(2);
    expect(result.findings).toEqual([]);
  });

  it("lets a later approval supersede an earlier COMMENTED body finding", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      formalReviews: [
        {
          id: 102,
          html_url: `${prUrl}#pullrequestreview-102`,
          submitted_at: "2026-07-26T09:00:00Z",
          user: { login: "reviewer" },
          body: "P1: Fix the unsafe path.",
          state: "COMMENTED",
          commit_id: headSha,
        },
        {
          id: 103,
          html_url: `${prUrl}#pullrequestreview-103`,
          submitted_at: "2026-07-26T09:05:00Z",
          user: { login: "reviewer" },
          body: "Approved after the fix.",
          state: "APPROVED",
          commit_id: headSha,
        },
      ],
      issueComments: [
        clawsweeperComment({
          id: 9116,
          body: passBody,
          updatedAt: "2026-07-26T09:06:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.formalReviews).toHaveLength(2);
    expect(result.findings).toEqual([]);
  });

  it("does not let a stale-head approval supersede a current-head blocker", async () => {
    const { provider } = createProvider({
      formalReviews: [
        {
          id: 104,
          submitted_at: "2026-07-26T09:00:00Z",
          user: { login: "reviewer" },
          body: "P1: Current-head blocker.",
          state: "CHANGES_REQUESTED",
          commit_id: headSha,
        },
        {
          id: 105,
          submitted_at: "2026-07-26T09:05:00Z",
          user: { login: "reviewer" },
          body: "Approval accidentally submitted against a stale commit.",
          state: "APPROVED",
          commit_id: staleSha,
        },
      ],
      issueComments: [
        clawsweeperComment({
          id: 9119,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:06:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "changes_requested" })]),
    );
  });

  it("lets a newer authenticated exact-head pass supersede an older bot blocker", async () => {
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({
          id: 9117,
          body: `P1: Old blocker.\n<!-- clawsweeper-verdict:block item=${pr} sha=${staleSha} -->`,
          updatedAt: "2026-07-26T09:00:00Z",
        }),
        clawsweeperComment({
          id: 9118,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:01:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.issueComments).toHaveLength(2);
    expect(result.findings).toEqual([]);
  });

  it("lets a newer exact-head bot pass supersede an older same-head bot blocker", async () => {
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({
          id: 9120,
          body: `P1: Old blocker.\n<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} -->`,
          updatedAt: "2026-07-26T09:00:00Z",
        }),
        clawsweeperComment({
          id: 9121,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:01:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findings).toEqual([]);
  });

  it("does not let a later bot pass suppress an unstamped bot blocker", async () => {
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({
          id: 9122,
          body: "P1: Blocker without an exact-head marker.",
          updatedAt: "2026-07-26T09:00:00Z",
        }),
        clawsweeperComment({
          id: 9123,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:01:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("missing an exact reviewed SHA");
  });

  it("keeps dismissed formal review findings as evidence without treating them as active", () => {
    const findings = extractFindingsFromEvidenceItem(
      {
        id: "dismissed",
        surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
        url: `${prUrl}#pullrequestreview-dismissed`,
        author: "maintainer",
        createdAt: "2026-07-26T09:00:00Z",
        effectiveAt: "2026-07-26T09:00:00Z",
        body: "P1: Historical blocker retained for context.",
        reviewState: "DISMISSED",
        reviewedSha: headSha,
        commitId: headSha,
      },
      headSha,
    );

    expect(findings).toEqual([]);
  });

  it.each([
    "P1: Active regression.",
    "Actionable findings: 1",
    "BLOCKED before merge.",
    "No P1 findings from the previous review; P1: New regression.",
    "P0: 0, P1: New regression.",
  ])("retains active review findings: %s", (body) => {
    const findings = extractFindingsFromEvidenceItem(
      {
        id: "active",
        surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
        url: `${prUrl}#pullrequestreview-active`,
        author: "maintainer",
        createdAt: "2026-07-26T09:00:00Z",
        effectiveAt: "2026-07-26T09:00:00Z",
        body,
        reviewState: "COMMENTED",
        reviewedSha: headSha,
        commitId: headSha,
      },
      headSha,
    );

    expect(findings.some((finding) => finding.currentHead)).toBe(true);
  });

  it("does not let a forged marker pin contributor review prose to the current head", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9103,
          html_url: `${prUrl}#issuecomment-9103`,
          created_at: "2026-07-26T08:06:00Z",
          user: { login: "contributor", type: "User" },
          body: [
            "P1: This contributor comment is not authenticated review evidence.",
            `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.findings).toEqual([]);
    expect(result.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it("uses a trusted command receipt to pin a PR-author re-review request to its head", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prAuthor: "contributor",
      issueComments: [
        {
          id: 8999,
          html_url: `${prUrl}#issuecomment-8999`,
          created_at: "2026-07-26T08:58:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: "@clawsweeper re-review",
        },
        {
          id: 9000,
          html_url: `${prUrl}#issuecomment-9000`,
          created_at: "2026-07-26T08:59:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: "@clawsweeper re-review",
        },
        clawsweeperComment({
          id: 9104,
          body: [
            "<!-- clawsweeper-command-ack:9000 -->",
            `<!-- clawsweeper-command-status:${pr}:re_review:${staleSha} -->`,
            `<!-- clawsweeper-command:9000:2026-07-26T08:59:00Z:re_review:${staleSha} -->`,
            "Re-review requested for the previous head.",
          ].join("\n"),
        }),
        clawsweeperComment({
          id: 9105,
          body: passBody,
          updatedAt: "2026-07-26T09:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({ re_review_request: 1 });
    expect(result.findings[0]).toMatchObject({
      kind: "re_review_request",
      reviewedSha: staleSha,
      currentHead: false,
      effectiveAt: "2026-07-26T08:59:00Z",
    });
  });

  it("does not let an old receipt suppress a later edit to the acknowledged request", async () => {
    const { provider } = createProvider({
      prAuthor: "contributor",
      issueComments: [
        {
          id: 9010,
          html_url: `${prUrl}#issuecomment-9010`,
          created_at: "2026-07-26T08:58:00Z",
          updated_at: "2026-07-26T09:02:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: "@clawsweeper re-review",
        },
        clawsweeperComment({
          id: 9110,
          body: [
            "<!-- clawsweeper-command-ack:9010 -->",
            `<!-- clawsweeper-command-status:${pr}:re_review:${staleSha} -->`,
            `<!-- clawsweeper-command:9010:2026-07-26T08:59:00Z:re_review:${staleSha} -->`,
          ].join("\n"),
          updatedAt: "2026-07-26T08:59:00Z",
        }),
        clawsweeperComment({
          id: 9111,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:01:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "re_review_request",
          sourceId: "9010",
          effectiveAt: "2026-07-26T09:02:00Z",
        }),
      ]),
    );
  });

  it("does not treat re-review instructions inside a ClawSweeper verdict as a request", async () => {
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({
          id: 9106,
          body: [
            "Fresh review can be requested by commenting `@clawsweeper re-review`.",
            `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          ].join("\n"),
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({});
  });

  it("returns UNKNOWN when target-branch required-check policy is unavailable", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9150, body: passBody })],
      requiredCheckPolicy: "unknown",
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toMatch(/target branch protection or ruleset policy/i);
    expect(result.nextAction).toMatch(/Resolve required checks/i);
  });

  it("returns UNKNOWN when a check run omits authoritative requiredness", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9160, body: passBody })],
      checkRuns: [
        {
          id: 1,
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          html_url: `${prUrl}/actions/runs/1`,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toMatch(/ambiguous/i);
    expect(result.evidence.checkRuns[0]?.required).toBeNull();
  });

  it("returns BLOCKED when required checks failed on the exact head", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9200, body: passBody })],
      checkRuns: [
        successfulCheck("CI", 1),
        {
          id: 2,
          name: "Workflow Sanity",
          status: "completed",
          conclusion: "failure",
          head_sha: headSha,
          html_url: `https://github.com/${repo}/actions/runs/2`,
          required: true,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.reason).toContain("Required checks failed");
    expect(result.evidence.checkRuns).toHaveLength(2);
    expect(result.evidence.checkRuns[1]?.conclusion).toBe("failure");
  });

  it("returns UNKNOWN when required checks are still pending", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9300, body: passBody })],
      checkRuns: [
        {
          id: 3,
          name: "CI",
          status: "in_progress",
          conclusion: null,
          head_sha: headSha,
          html_url: `https://github.com/${repo}/actions/runs/3`,
          required: true,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("pending");
    expect(result.nextAction).toContain("required checks");
  });

  it("fails closed to UNKNOWN when evidence pagination is incomplete", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9400, body: passBody })],
      completeness: {
        issue_comments: false,
      },
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("incomplete");
    expect(result.evidence.surfaceCoverage.issue_comments).toEqual({
      complete: false,
      count: 1,
    });
    expect(result.nextAction).toContain("Paginate");
  });

  it("returns UNKNOWN when the PR head changes during the audit", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const movedHead = "bbbbccccddddeeeeffffaaaabbbbccccddddeeee";
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9500, body: passBody })],
      headShaInitial: headSha,
      headShaFinal: movedHead,
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("head changed");
    expect(result.nextAction).toContain("stabilizes");
  });

  it("re-reads PR identity after all evidence collection finishes", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const movedHead = "bbbbccccddddeeeeffffaaaabbbbccccddddeeee";
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9501, body: passBody })],
    });
    const fetchPullRequest = provider.fetchPullRequest;
    const fetchIssueComments = provider.fetchIssueComments;
    let currentHead = headSha;
    let identityReads = 0;
    provider.fetchPullRequest = async () => {
      identityReads += 1;
      const pull = await fetchPullRequest();
      return { ...pull, head: { ...pull.head, sha: currentHead } };
    };
    let releaseIssueComments!: () => void;
    const issueCommentsBarrier = new Promise<void>((resolve) => {
      releaseIssueComments = resolve;
    });
    provider.fetchIssueComments = async () => {
      await issueCommentsBarrier;
      return fetchIssueComments();
    };

    const audit = auditPrConvergence({ repo, pr, provider });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const identityReadsBeforeEvidence = identityReads;
    currentHead = movedHead;
    releaseIssueComments();
    const result = await audit;

    expect(identityReadsBeforeEvidence).toBe(1);
    expect(identityReads).toBe(2);
    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("head changed");
  });

  it("fails closed when mutable evidence changes between validation reads", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const blockerBody = [
      "P1: A blocker arrived after the first evidence snapshot.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9502, body: passBody })],
    });
    const fetchIssueComments = provider.fetchIssueComments.bind(provider);
    let issueCommentReads = 0;
    provider.fetchIssueComments = async () => {
      issueCommentReads += 1;
      const result = await fetchIssueComments();
      if (issueCommentReads === 1) {
        return result;
      }
      return {
        ...result,
        items: [
          ...result.items,
          clawsweeperComment({
            id: 9503,
            body: blockerBody,
            createdAt: "2026-07-26T09:01:00Z",
          }),
        ],
      };
    };

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(issueCommentReads).toBe(2);
    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("evidence changed");
    expect(result.nextAction).toContain("stabilizes");
  });

  it("never yields READY from formal review state alone", () => {
    const evidence = {
      repo,
      pr,
      headSha,
      headRef: "branch",
      baseRef: "main",
      prUrl,
      prTitle: "Audit PR convergence",
      prState: "OPEN",
      isDraft: false,
      prLastEditedAt: null,
      formalReviews: [
        {
          id: "1",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-1`,
          author: "maintainer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
          body: "Looks good.",
          reviewState: "APPROVED",
          reviewedSha: headSha,
          commitId: headSha,
        },
      ],
      inlineReviewComments: [],
      issueComments: [],
      requestedReviewers: [],
      checkRuns: [successfulCheck("CI", 1)],
      requiredCheckPolicy: "resolved" as const,
      surfaceCoverage: {
        formal_reviews: { complete: true, count: 1 },
        inline_review_comments: { complete: true, count: 0 },
        issue_comments: { complete: true, count: 0 },
        requested_reviewers: { complete: true, count: 0 },
        check_runs: { complete: true, count: 1 },
      },
      errors: [],
    };

    const decision = decidePrConvergence({
      evidence,
      findings: [],
      headStable: true,
      prContentStable: true,
      hasExactHeadClawSweeperPass: false,
      hasFreshExactHeadClawSweeperPass: false,
    });

    expect(decision.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(decision.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it.each([
    { state: "COMMENTED", reviewedSha: staleSha },
    { state: "COMMENTED", reviewedSha: headSha },
    { state: "PENDING", reviewedSha: headSha },
  ])("fails closed for $state formal review evidence at $reviewedSha", ({ state, reviewedSha }) => {
    const evidence = {
      repo,
      pr,
      headSha,
      headRef: "branch",
      baseRef: "main",
      prUrl,
      prTitle: "Audit PR convergence",
      prState: "OPEN",
      isDraft: false,
      prLastEditedAt: null,
      formalReviews: [
        {
          id: "2",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-2`,
          author: "reviewer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
          body: "Review recorded.",
          reviewState: state,
          reviewedSha,
          commitId: reviewedSha,
        },
      ],
      inlineReviewComments: [],
      issueComments: [],
      requestedReviewers: [],
      checkRuns: [successfulCheck("CI", 1)],
      requiredCheckPolicy: "resolved" as const,
      surfaceCoverage: {
        formal_reviews: { complete: true, count: 1 },
        inline_review_comments: { complete: true, count: 0 },
        issue_comments: { complete: true, count: 0 },
        requested_reviewers: { complete: true, count: 0 },
        check_runs: { complete: true, count: 1 },
      },
      errors: [],
    };

    const decision = decidePrConvergence({
      evidence,
      findings: [],
      headStable: true,
      prContentStable: true,
      hasExactHeadClawSweeperPass: false,
      hasFreshExactHeadClawSweeperPass: false,
    });

    expect(decision.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(decision.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it("returns UNKNOWN when a provider fetch throws instead of propagating the exception", async () => {
    const provider = {
      async fetchPullRequest() {
        throw new Error("GitHub API rate limit exceeded");
      },
      async fetchFormalReviews() {
        return { items: [], complete: true };
      },
      async fetchInlineReviewComments() {
        return { items: [], complete: true };
      },
      async fetchIssueComments() {
        return { items: [], complete: true };
      },
      async fetchRequestedReviewers() {
        return { logins: [], complete: true };
      },
      async fetchCheckRuns() {
        return { items: [], complete: true };
      },
    };

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("Provider or API error");
    expect(result.reason).toContain("rate limit");
    expect(result.nextAction).toMatch(/re-run the convergence audit/i);
    expect(result.evidence.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("rate limit")]),
    );
  });

  it("invalidates an exact-head pass when the PR content was edited afterward", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9650,
          body: passBody,
          updatedAt: "2026-07-26T09:59:59Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
    expect(result.nextAction).toMatch(/fresh exact-head ClawSweeper review/i);
  });

  it("invalidates an exact-head pass when the PR title was edited afterward", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prTitleInitial: "Updated audit title",
      prTitleEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9654,
          body: passBody,
          updatedAt: "2026-07-26T09:59:59Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
    expect(result.evidence.prTitle).toBe("Updated audit title");
    expect(result.evidence.prLastEditedAt).toBe("2026-07-26T10:00:00Z");
  });

  it("invalidates an exact-head pass when the PR base was retargeted afterward", async () => {
    const { provider } = createProvider({
      baseRefInitial: "stable",
      prBaseEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9658,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T09:59:59Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
    expect(result.evidence.baseRef).toBe("stable");
    expect(result.evidence.prLastEditedAt).toBe("2026-07-26T10:00:00Z");
  });

  it("accepts an in-place exact-head verdict update after the latest PR content edit", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9651,
          body: passBody,
          createdAt: "2026-07-26T09:00:00Z",
          updatedAt: "2026-07-26T10:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.prLastEditedAt).toBe("2026-07-26T10:00:00Z");
  });

  it("fails closed when second-granularity timestamps cannot order the content edit and pass", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9653,
          body: passBody,
          updatedAt: "2026-07-26T10:00:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
  });

  it("fails closed when PR content changes during evidence collection", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      prLastEditedAtFinal: "2026-07-26T10:01:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9652,
          body: passBody,
          updatedAt: "2026-07-26T10:01:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("changed between the initial and final audit reads");
    expect(result.nextAction).toMatch(/content stabilizes/i);
  });

  it("fails closed when the PR title changes during evidence collection", async () => {
    const { provider } = createProvider({
      prTitleInitial: "Original title",
      prTitleFinal: "Edited title",
      prTitleEditedAtFinal: "2026-07-26T10:01:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9655,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: "2026-07-26T10:01:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("changed between the initial and final audit reads");
    expect(result.evidence.prTitle).toBe("Edited title");
  });

  it("fails closed when the PR base branch changes during evidence collection", async () => {
    const { provider } = createProvider({
      baseRefInitial: "main",
      baseRefFinal: "stable",
      issueComments: [
        clawsweeperComment({
          id: 9656,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("changed between the initial and final audit reads");
    expect(result.evidence.baseRef).toBe("stable");
  });

  it("never reports a draft pull request as ready", async () => {
    const { provider } = createProvider({
      draftInitial: true,
      issueComments: [
        clawsweeperComment({
          id: 9657,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("still a draft");
  });

  it("returns UNKNOWN when actionable evidence lacks an exact reviewed SHA", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9700,
          html_url: `${prUrl}#issuecomment-9700`,
          created_at: "2026-07-26T09:30:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: "P0: Missing regression proof for the changed gateway path.",
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("missing an exact reviewed SHA");
    expect(
      result.findings.some((finding) => finding.kind === "p0" && finding.reviewedSha === null),
    ).toBe(true);
    expect(result.findings.every((finding) => !finding.currentHead)).toBe(true);
    expect(result.nextAction).toMatch(/marker SHAs/i);
  });

  it("returns UNKNOWN for an exact-head re-review request instead of READY", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prAuthor: "contributor",
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9800,
          body: passBody,
        }),
        {
          id: 9801,
          html_url: `${prUrl}#issuecomment-9801`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: [
            "@clawsweeper re-review",
            "",
            "Please take another look after the proof update.",
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("exact-head re-review");
    expect(result.findingCounts.re_review_request).toBe(1);
    expect(
      result.findings.some(
        (finding) => finding.kind === "re_review_request" && finding.currentHead,
      ),
    ).toBe(true);
    expect(result.nextAction).toMatch(/fresh exact-head/i);
  });

  it("accepts a trusted exact-head pass that is newer than the re-review request", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9802,
          html_url: `${prUrl}#issuecomment-9802`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
        clawsweeperComment({
          id: 9803,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          createdAt: "2026-07-26T09:00:00Z",
          updatedAt: "2026-07-26T10:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts.re_review_request).toBe(1);
  });

  it("fails closed when a pass and re-review request have equal timestamps", async () => {
    const requestAt = "2026-07-26T10:00:00Z";
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9804,
          html_url: `${prUrl}#issuecomment-9804`,
          created_at: requestAt,
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
        clawsweeperComment({
          id: 9805,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: requestAt,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("exact-head re-review");
  });

  it("returns UNKNOWN for a stale re-review request instead of silently ignoring it", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9900,
          html_url: `${prUrl}#issuecomment-9900`,
          created_at: "2026-07-26T10:05:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${staleSha} -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("Stale re-review requests");
    expect(result.findingCounts.re_review_request).toBe(1);
    expect(result.nextAction).toMatch(/fresh exact-head ClawSweeper re-review/i);
  });

  it("normalizes issue comment URLs and reviewed SHAs from ClawSweeper markers", () => {
    const normalized = normalizeIssueComment(
      clawsweeperComment({
        id: 9600,
        body: `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} -->`,
      }),
      repo,
      pr,
    );

    expect(normalized.url).toBe(`${prUrl}#issuecomment-9600`);
    expect(normalized.reviewedSha).toBe(headSha);
    expect(
      extractFindingsFromEvidenceItem(
        {
          ...normalized,
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
        headSha,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "clawsweeper_verdict_block",
          currentHead: true,
          sourceSurface: EVIDENCE_SURFACES.ISSUE_COMMENT,
        }),
      ]),
    );
  });
});
