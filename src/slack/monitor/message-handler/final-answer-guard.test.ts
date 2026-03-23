import { describe, expect, it } from "vitest";
import {
  enforceSlackDirectEitherOrAnswer,
  enforceSlackDisprovedTheoryRetraction,
  extractEitherOrQuestion,
  shouldRequireSlackDisprovedTheory,
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
