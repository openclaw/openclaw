import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  applySlackFinalReplyGuards,
  enforceSlackDirectEitherOrAnswer,
  enforceSlackEvidenceConsistency,
  enforceSlackNoProgressOnlyReply,
  enforceSlackNumericSummaryConsistency,
  enforceSlackDisprovedTheoryRetraction,
  extractEitherOrQuestion,
  shouldRequireSlackDisprovedTheory,
  shouldSuppressSlackProgressReply,
} from "./final-answer-guard.js";

describe("extractEitherOrQuestion", () => {
  it("extracts options from explicit either-or questions", () => {
    expect(extractEitherOrQuestion("What's best? Indian or Chinese food?")).toEqual({
      leftOption: "Indian",
      rightOption: "Chinese food",
    });
  });

  it("ignores messages without either-or question form", () => {
    expect(extractEitherOrQuestion("Can you help with this")).toBeNull();
    expect(extractEitherOrQuestion("Can you help? thanks")).toBeNull();
  });
});

describe("enforceSlackDirectEitherOrAnswer", () => {
  it("injects a direct-answer prefix when reply misses both options", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "What's best? Indian or Chinese food?",
      payload: { text: "Absolute banger. Cyber-firefighter mode approved." },
    });

    expect(payload.text).toBe(
      "Direct answer: it depends.\n\nAbsolute banger. Cyber-firefighter mode approved.",
    );
  });

  it("keeps replies that already choose one option", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "Indian or Chinese food?",
      payload: { text: "Chinese food today, faster and lighter." },
    });

    expect(payload.text).toBe("Chinese food today, faster and lighter.");
  });

  it("does nothing when prompt is not either-or", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "Can you check rollout health?",
      payload: { text: "Yes. Looking now." },
    });

    expect(payload.text).toBe("Yes. Looking now.");
  });
});

describe("slack numeric summary consistency guard", () => {
  const mismatchedSummaryReply = `[[reply_to_current]] Here's the same breakdown, filtered to vaults with ≥ $10k total assets:

**Vaults ≥ $10k: 544 total**

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| **Grand total** | **444** | **319** | **125** |

For comparison, the unfiltered numbers:

| Version | All | ≥ $10k | < $10k |
|---------|----:|-------:|-------:|
| v1 | 201 | 55 | 146 |
| v1.1 | 1,117 | 255 | 862 |
| v2 | 1,069 | 134 | 935 |
| **Total** | **2,387** | **444** | **1,943** |

~81% of all vaults have under $10k in assets.`;

  const evidenceTexts = [
    `--- v1 total >= 10k ---
55
--- v1 listed ---
48
--- v1 unlisted ---
7`,
    `- v1.1: 255 total, 174 listed, 81 unlisted
- v2: 134 total, 97 listed, 37 unlisted`,
    `| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
  ];

  it("rewrites a mismatched headline total from the first markdown table", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: { text: mismatchedSummaryReply },
    });

    expect(payload.text).toContain("**Vaults ≥ $10k: 444 total**");
    expect(payload.text).not.toContain("**Vaults ≥ $10k: 544 total**");
  });

  it("runs for all final Slack replies, not only incident-root-only threads", () => {
    const payload = applySlackFinalReplyGuards({
      questionText: "same lists as before but split for 10k",
      inboundText: "same lists as before but split for 10k",
      evidenceTexts,
      incidentRootOnly: false,
      isThreadReply: true,
      payload: { text: mismatchedSummaryReply },
    });

    expect(payload.text).toContain("**Vaults ≥ $10k: 444 total**");
  });

  it("rewrites labeled evidence lines before reconciling the summary total", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts,
      payload: {
        text: `- v1.1: 255 total, 174 listed, 18 unlisted
- v2: 134 total, 79 listed, 37 unlisted

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 18 |
| v2 | 134 | 79 | 37 |
| Grand total | 444 | 301 | 62 |`,
      },
    });

    expect(payload.text).toContain("- v1.1: 255 total, 174 listed, 81 unlisted");
    expect(payload.text).toContain("- v2: 134 total, 97 listed, 37 unlisted");
    expect(payload.text).toContain("| v1.1 | 255 | 174 | 81 |");
    expect(payload.text).toContain("| v2 | 134 | 97 | 37 |");
    expect(payload.text).toContain("| Grand total | 444 | 319 | 125 |");
  });

  it("does not recompute table totals from reply-only rows that lack evidence", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: ["- v1: 55 total, 48 listed, 7 unlisted"],
      payload: {
        text: `| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 999 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      },
    });

    expect(payload.text).toContain("| v2 | 999 | 97 | 37 |");
    expect(payload.text).toContain("| Grand total | 444 | 319 | 125 |");
    expect(payload.text).not.toContain("| Grand total | 1,309 | 319 | 125 |");
  });

  it("recomputes a single-row total when that row is uniquely evidence-backed", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: ["- us-east-1: 5 total"],
      payload: {
        text: `| Region | Total |
|--------|------:|
| us-east-1 | 7 |
| Grand total | 7 |`,
      },
    });

    expect(payload.text).toContain("| us-east-1 | 5 |");
    expect(payload.text).toContain("| Grand total | 5 |");
  });

  it("ignores inconsistent total rows from evidence tables", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: [
        `| Region | Total |
|--------|------:|
| us-east-1 | 5 |
| Grand total | 999 |`,
      ],
      payload: {
        text: "- Grand total: 7 total",
      },
    });

    expect(payload.text).toBe("- Grand total: 7 total");
  });

  it("keeps the reply unchanged when the table total is not internally consistent", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: mismatchedSummaryReply.replace(
          "**444** | **319** | **125**",
          "**445** | **319** | **125**",
        ),
      },
    });

    expect(payload.text).toContain("**Vaults ≥ $10k: 544 total**");
    expect(payload.text).toContain("| **Grand total** | **445** | **319** | **125** |");
  });

  it("keeps the reply unchanged when the primary table column cannot be fully validated", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Vaults ≥ $10k: 544 total

| Version | Total ≥ $10k | Listed |
|---------|------------:|-------:|
| v1 | n/a | 48 |
| Grand total | 444 | 48 |`,
      },
    });

    expect(payload.text).toContain("Vaults ≥ $10k: 544 total");
    expect(payload.text).toContain("| v1 | n/a | 48 |");
  });

  it("ignores malformed markdown tables whose separator columns do not match the header", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Vaults ≥ $10k: 544 total

| Version | Total ≥ $10k | Listed |
|---------|------------:|
| v1 | 55 | 48 |
| Grand total | 444 | 48 |`,
      },
    });

    expect(payload.text).toContain("Vaults ≥ $10k: 544 total");
  });

  it("rejects totals that would lose integer precision", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Vaults ≥ $10k: 544 total

| Version | Total ≥ $10k |
|---------|------------:|
| v1 | 9,007,199,254,740,992 |
| Grand total | 9,007,199,254,740,992 |`,
      },
    });

    expect(payload.text).toContain("Vaults ≥ $10k: 544 total");
  });

  it("rejects totals that would lose decimal precision", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Vaults ≥ $10k: 544 total

| Version | Total ≥ $10k |
|---------|------------:|
| v1 | 9,007,199,254,740,991.5 |
| Grand total | 9,007,199,254,740,991.5 |`,
      },
    });

    expect(payload.text).toContain("Vaults ≥ $10k: 544 total");
  });

  it("accepts exact max-safe-integer totals without precision loss", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Vaults ≥ $10k: 544 total

| Version | Total ≥ $10k |
|---------|------------:|
| v1 | 9,007,199,254,740,991 |
| Grand total | 9,007,199,254,740,991 |`,
      },
    });

    expect(payload.text).toContain("Vaults ≥ $10k: 9,007,199,254,740,991 total");
  });

  it("skips oversized numeric-like evidence lines before token extraction", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: [`Grand total: ${"1,".repeat(1_500)} total`],
      payload: { text: "- Grand total: 7 total" },
    });

    expect(payload.text).toBe("- Grand total: 7 total");
  });

  it("does not rewrite narrative context lines above the first table", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Historical inventory had 2,387 total vaults before filtering.

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      },
    });

    expect(payload.text).toContain("Historical inventory had 2,387 total vaults before filtering.");
  });

  it("does not rewrite unrelated contextual totals above the filtered table", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `All vaults: 2,387 total

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      },
    });

    expect(payload.text).toContain("All vaults: 2,387 total");
    expect(payload.text).not.toContain("All vaults: 444 total");
  });

  it("stops scanning once it leaves the immediate summary block above the table", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `Overall inventory: 2,387 total

Filtered subset details:

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      },
    });

    expect(payload.text).toContain("Overall inventory: 2,387 total");
    expect(payload.text).not.toContain("Overall inventory: 444 total");
  });

  it("does not rewrite per-version metric lines as the summary total", () => {
    const payload = enforceSlackNumericSummaryConsistency({
      payload: {
        text: `- v1: 55 total

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      },
    });

    expect(payload.text).toContain("- v1: 55 total");
    expect(payload.text).not.toContain("- v1: 444 total");
  });

  it("leaves replies unchanged when conflicting evidence values exist for the same metric", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: [
        "- v1: 55 total, 48 listed, 7 unlisted",
        "- v1: 55 total, 50 listed, 7 unlisted",
      ],
      payload: {
        text: "- v1: 55 total, 47 listed, 7 unlisted",
      },
    });

    expect(payload.text).toBe("- v1: 55 total, 47 listed, 7 unlisted");
  });

  it("rewrites metric-line-only replies without markdown tables", () => {
    const payload = enforceSlackEvidenceConsistency({
      evidenceTexts: ["- v2: 134 total, 97 listed, 37 unlisted"],
      payload: {
        text: "- v2: 134 total, 79 listed, 37 unlisted",
      },
    });

    expect(payload.text).toBe("- v2: 134 total, 97 listed, 37 unlisted");
  });

  it("leaves payloads unchanged when evidence is empty or the payload is an error", () => {
    const errorPayload = {
      text: mismatchedSummaryReply,
      isError: true,
    } as const;

    expect(
      enforceSlackEvidenceConsistency({
        evidenceTexts: [],
        payload: { text: "- v2: 134 total, 79 listed, 37 unlisted" },
      }).text,
    ).toBe("- v2: 134 total, 79 listed, 37 unlisted");
    expect(enforceSlackEvidenceConsistency({ evidenceTexts, payload: errorPayload })).toBe(
      errorPayload,
    );
    expect(enforceSlackNumericSummaryConsistency({ payload: errorPayload })).toBe(errorPayload);
  });
});

describe("slack progress-only guard", () => {
  it("detects exact progress-chatter prefixes from incident threads", () => {
    expect(
      shouldSuppressSlackProgressReply(
        "Now let me look at the hooks to understand the `staleTime: Infinity` pattern:",
      ),
    ).toBe(true);
    expect(
      shouldSuppressSlackProgressReply("Commit is verified/signed. Now create the branch and PR:"),
    ).toBe(true);
    expect(
      shouldSuppressSlackProgressReply(
        "Everything looks clean. Now let me add the new file and commit:",
      ),
    ).toBe(true);
  });

  it("keeps substantive thread replies", () => {
    expect(
      shouldSuppressSlackProgressReply(`*Incident:* Stable query-key rollout ready.
*Status:* PR https://github.com/morpho-org/sdks/pull/533 is green.
*Next:* Merge after review.`),
    ).toBe(false);
    expect(shouldSuppressSlackProgressReply("PR #123 is green.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Good - PR #123 is green.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Good news: PR #123 is green.")).toBe(false);
    expect(
      shouldSuppressSlackProgressReply(`*incident:* Stable query-key rollout ready.
*status:* Monitoring complete.`),
    ).toBe(false);
  });

  it("treats each substantive signal family as non-progress content", () => {
    expect(
      shouldSuppressSlackProgressReply("Linear ticket: https://linear.app/acme/issue/SDK-97"),
    ).toBe(false);
    expect(shouldSuppressSlackProgressReply("CI is still pending on the current branch.")).toBe(
      false,
    );
    expect(shouldSuppressSlackProgressReply("Now let me check CI - it's probably green.")).toBe(
      false,
    );
    expect(
      shouldSuppressSlackProgressReply("Failing job: build / @morpho-org/blue-sdk-wagmi"),
    ).toBe(false);
    expect(
      shouldSuppressSlackProgressReply("Regression is in test / vitest for Slack delivery"),
    ).toBe(false);
    expect(
      shouldSuppressSlackProgressReply("Repo ref: morpho-org/openclaw-sre#114 is ready."),
    ).toBe(false);
    expect(shouldSuppressSlackProgressReply("PR: #114 is green.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Direct link: pull/114 is ready.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Migration completed. Checking logs.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Database recovered. Monitoring.")).toBe(false);
  });

  it("lets substantive signals win even when progress phrasing appears first", () => {
    expect(shouldSuppressSlackProgressReply("Let me check... PR #123 is green.")).toBe(false);
    expect(
      shouldSuppressSlackProgressReply("Now let me show you the fix: PR #123 fixes the issue."),
    ).toBe(false);
    expect(
      shouldSuppressSlackProgressReply('PR #123 updated the banned string "Now let me".'),
    ).toBe(false);
    expect(
      shouldSuppressSlackProgressReply(
        "<@U123>\n[[heartbeat_to:#sdks]]\nLet me check... morpho-org/openclaw-sre#114 is green.",
      ),
    ).toBe(false);
  });

  it("treats indented italic incident summaries as substantive", () => {
    expect(
      shouldSuppressSlackProgressReply(`  _Incident:_ Stable query-key rollout ready.
  _Status:_ Ready to merge after validation.
  _Next:_ Watch deploy.`),
    ).toBe(false);
  });

  it("still suppresses short progress chatter without a substantive signal", () => {
    expect(shouldSuppressSlackProgressReply("Good - let me commit this fix.")).toBe(true);
    expect(shouldSuppressSlackProgressReply("Honest answer: I need to rerun CI.")).toBe(true);
    expect(shouldSuppressSlackProgressReply("The script completed. Now I'll open the PR.")).toBe(
      true,
    );
  });

  it("does not treat terse substantive confirmations as progress chatter", () => {
    expect(shouldSuppressSlackProgressReply("Good news: the fix is deployed.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Good.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Done.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Fixed.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("The script contains the failing job names.")).toBe(
      false,
    );
    expect(shouldSuppressSlackProgressReply("The script ran successfully.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("The commit was created yesterday for PR #114.")).toBe(
      false,
    );
  });

  it("ignores empty and punctuation-only replies", () => {
    expect(shouldSuppressSlackProgressReply("")).toBe(false);
    expect(shouldSuppressSlackProgressReply("   \n\t  ")).toBe(false);
    expect(shouldSuppressSlackProgressReply("...")).toBe(false);
  });

  it("skips suppression for oversized replies", () => {
    expect(shouldSuppressSlackProgressReply(`Now let me ${"x".repeat(12_001)}`)).toBe(false);
  });

  it("still evaluates replies just under the size cutoff", () => {
    expect(shouldSuppressSlackProgressReply(`Now let me ${"x".repeat(11_988)}`)).toBe(true);
  });

  it("still evaluates replies exactly at the size cutoff", () => {
    expect(shouldSuppressSlackProgressReply(`Now let me ${"x".repeat(11_989)}`)).toBe(true);
  });

  it("handles non-ascii text without suppressing substantive replies", () => {
    expect(shouldSuppressSlackProgressReply("Now let me check the rollout 🚀")).toBe(true);
    expect(shouldSuppressSlackProgressReply("Good news: déploiement terminé.")).toBe(false);
    expect(shouldSuppressSlackProgressReply("Good ‒ let me commit this fix.")).toBe(true);
  });

  it("ignores malformed mention-only lead lines before checking progress text", () => {
    expect(shouldSuppressSlackProgressReply("<@>\nNow let me check the rollout")).toBe(true);
  });

  it("suppresses progress chatter when the first substantive line comes after a mention", () => {
    expect(shouldSuppressSlackProgressReply("<@U123>\nNow let me check the CI status...")).toBe(
      true,
    );
  });

  it("suppresses progress-only final payloads in incident-root-only thread replies", () => {
    const payload = enforceSlackNoProgressOnlyReply({
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: "Now I'll recreate the branch and commits using the GitHub API:",
      },
    });

    expect(payload.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("keeps the same payload outside final-only incident thread mode", () => {
    const payload = enforceSlackNoProgressOnlyReply({
      incidentRootOnly: false,
      isThreadReply: true,
      payload: {
        text: "Now I'll recreate the branch and commits using the GitHub API:",
      },
    });

    expect(payload.text).toBe("Now I'll recreate the branch and commits using the GitHub API:");
  });
});

describe("slack contradicted-theory guard", () => {
  it("requires a retraction for explicit human corrections in incident thread follow-ups", () => {
    expect(
      shouldRequireSlackDisprovedTheory({
        inboundText:
          "This is not a UI problem. The bug is increase timelock to 3, not decrease to 1.",
        incidentRootOnly: true,
        isThreadReply: true,
      }),
    ).toBe(true);
  });

  it("matches human corrections case-insensitively without tripping on generic 'this is not' phrasing", () => {
    expect(
      shouldRequireSlackDisprovedTheory({
        inboundText: "THIS IS WRONG. The bug is elsewhere.",
        incidentRootOnly: true,
        isThreadReply: true,
      }),
    ).toBe(true);

    expect(
      shouldRequireSlackDisprovedTheory({
        inboundText: "This is not ready for production yet.",
        incidentRootOnly: true,
        isThreadReply: true,
      }),
    ).toBe(false);
  });

  it("requires a retraction when multiple correction cues appear in the same message", () => {
    expect(
      shouldRequireSlackDisprovedTheory({
        inboundText:
          "This is wrong. Current lead is stale. The bug is pending action chronology instead of label rendering.",
        incidentRootOnly: true,
        isThreadReply: true,
      }),
    ).toBe(true);
  });

  it("injects a disproved-theory line after status when a correction arrives", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText:
        "This is not a UI problem. The bug is increase timelock to 3, not decrease to 1.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: `*Incident:* Pending timelock chronology mismatch remains unconfirmed.
*Customer impact:* One curator reported confusing pending action state.
*Status:* Rechecking after thread correction.
*Evidence:* Latest human correction says the final action was increase to 3, not decrease to 1.`,
      },
    });

    expect(payload.text).toBe(`*Incident:* Pending timelock chronology mismatch remains unconfirmed.
*Customer impact:* One curator reported confusing pending action state.
*Status:* Rechecking after thread correction.
Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.
*Evidence:* Latest human correction says the final action was increase to 3, not decrease to 1.`);
  });

  it("injects after status even when routing tags and mentions precede incident", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText:
        "This is not a UI problem. The bug is increase timelock to 3, not decrease to 1.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: `[[heartbeat_to:#platform-monitoring]]
<@U07KE3NALTX>
*Incident:* Pending timelock chronology mismatch remains unconfirmed.
*Status:* Rechecking after thread correction.
*Evidence:* Latest human correction says the final action was increase to 3, not decrease to 1.`,
      },
    });

    expect(payload.text).toBe(`[[heartbeat_to:#platform-monitoring]]
<@U07KE3NALTX>
*Incident:* Pending timelock chronology mismatch remains unconfirmed.
*Status:* Rechecking after thread correction.
Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.
*Evidence:* Latest human correction says the final action was increase to 3, not decrease to 1.`);
  });

  it("injects after the incident line when no status line exists", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText: "THIS IS WRONG. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: `*Incident:* Re-scoping.
*Evidence:* Fresh replay says otherwise.`,
      },
    });

    expect(payload.text).toBe(`*Incident:* Re-scoping.
Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.
*Evidence:* Fresh replay says otherwise.`);
  });

  it("appends the disproved-theory line when the incident line is the whole reply", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText: "THIS IS WRONG. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: "*Incident:* Re-scoping.",
      },
    });

    expect(payload.text).toBe(`*Incident:* Re-scoping.
Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.`);
  });

  it("injects after the first status line when later status-like lines exist", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText: "This is wrong. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: `*Incident:* Re-scoping.
*Status:* Rechecking after correction.
*Evidence:* Fresh replay says otherwise.
*Status:* Historical note from an older update.`,
      },
    });

    expect(payload.text).toBe(`*Incident:* Re-scoping.
*Status:* Rechecking after correction.
Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.
*Evidence:* Fresh replay says otherwise.
*Status:* Historical note from an older update.`);
  });

  it("keeps malformed incident replies unchanged when no incident header exists", () => {
    const payload = enforceSlackDisprovedTheoryRetraction({
      inboundText: "This is wrong. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: { text: "*Evidence:* only evidence" },
    });

    expect(payload.text).toBe("*Evidence:* only evidence");
  });

  it("keeps non-incident or already-retracted replies unchanged", () => {
    const alreadyRetracted = enforceSlackDisprovedTheoryRetraction({
      inboundText: "This is wrong. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: {
        text: `*Incident:* Re-scoping.
Disproved theory: old lead was stale.
*Evidence:* Fresh replay says otherwise.`,
      },
    });

    expect(alreadyRetracted.text).toBe(`*Incident:* Re-scoping.
Disproved theory: old lead was stale.
*Evidence:* Fresh replay says otherwise.`);

    const retractedTwice = enforceSlackDisprovedTheoryRetraction({
      inboundText: "This is wrong. The bug is elsewhere.",
      incidentRootOnly: true,
      isThreadReply: true,
      payload: alreadyRetracted,
    });

    expect(retractedTwice.text).toBe(alreadyRetracted.text);

    const nonIncident = enforceSlackDisprovedTheoryRetraction({
      inboundText: "This is wrong. The bug is elsewhere.",
      incidentRootOnly: false,
      isThreadReply: true,
      payload: { text: "Plain reply." },
    });

    expect(nonIncident.text).toBe("Plain reply.");
  });
});
