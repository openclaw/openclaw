import { describe, expect, it } from "vitest";
import {
  buildProposedPlanImplementationPrompt,
  hasProposedPlanSegment,
  parseProposedPlanSegments,
  stripProposedPlanTagsForMarkdown,
} from "./proposed-plan.ts";

describe("parseProposedPlanSegments", () => {
  it("returns normal markdown when no proposed plan block exists", () => {
    const segments = parseProposedPlanSegments("Hello **world**");

    expect(segments).toEqual([{ kind: "markdown", markdown: "Hello **world**" }]);
    expect(hasProposedPlanSegment(segments)).toBe(false);
  });

  it("parses a valid plan block and surrounding markdown", () => {
    const segments = parseProposedPlanSegments(
      "Intro\n<proposed_plan>\n# Plan\n- Step one\n</proposed_plan>\nOutro",
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "markdown", markdown: "Intro\n" });
    expect(segments[1]).toMatchObject({
      kind: "proposed_plan",
      markdown: "# Plan\n- Step one",
      status: "awaiting_approval",
      implementationPrompt: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n- Step one",
    });
    expect(segments[2]).toMatchObject({ kind: "markdown", markdown: "\nOutro" });
  });

  it("marks streaming incomplete plans as drafting", () => {
    const segments = parseProposedPlanSegments("<proposed_plan>\n# Still writing", {
      isStreaming: true,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "proposed_plan",
      markdown: "# Still writing",
      status: "drafting",
      missingCloseTag: true,
    });
  });

  it("marks final unmatched opening tags as blocked", () => {
    const segments = parseProposedPlanSegments("Before\n<proposed_plan>\n# Broken");

    expect(segments[1]).toMatchObject({
      kind: "proposed_plan",
      status: "blocked",
      markdown: "# Broken",
      missingCloseTag: true,
    });
  });

  it("marks unmatched closing tags as blocked", () => {
    const segments = parseProposedPlanSegments("Before\n</proposed_plan>\nAfter");

    expect(segments[1]).toMatchObject({
      kind: "proposed_plan",
      status: "blocked",
      unmatchedCloseTag: true,
    });
    expect(segments[2]).toMatchObject({ kind: "markdown", markdown: "\nAfter" });
  });

  it("marks a plan ready when the composer contains the generated implementation prompt", () => {
    const prompt = buildProposedPlanImplementationPrompt("# Plan\n- Step one");
    const segments = parseProposedPlanSegments(
      "<proposed_plan># Plan\n- Step one</proposed_plan>",
      {
        composerDraft: `Notes\n${prompt}`,
      },
    );

    expect(segments[0]).toMatchObject({ kind: "proposed_plan", status: "ready" });
  });

  it("strips raw proposed plan tags for markdown copy/expand surfaces", () => {
    expect(
      stripProposedPlanTagsForMarkdown("A\n<proposed_plan>\n# Plan\n</proposed_plan>\nB"),
    ).toBe("A\n\n# Plan\n\nB");
  });
});
