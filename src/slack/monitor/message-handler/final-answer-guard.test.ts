import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  enforceSlackDirectEitherOrAnswer,
  enforceSlackNoProgressOnlyReply,
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
