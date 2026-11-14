import { expect, it } from "vitest";
import { selectBilledTranscriptEvents } from "./session-cost-usage-inherited.js";

// Rows produced by running switch-then-rewind on the merge base, where each cut
// copied the whole tree into a new session. Entry ids are copied verbatim, so the
// same billed turn appears in all three windows; `inheritedThrough` names the
// paths each source already counted. Captured with ocx base merge-base.
const MESSAGES = [
  { id: "u1", parentId: null, tokens: 0 },
  { id: "a1", parentId: "u1", tokens: 10 },
  { id: "u2b", parentId: "a1", tokens: 0 },
  { id: "a2b", parentId: "u2b", tokens: 40 },
  { id: "u2", parentId: "a1", tokens: 0 },
  { id: "a2", parentId: "u2", tokens: 20 },
] as const;

type Row = Record<string, unknown>;

function window(sessionId: string, inheritedThrough: string[], leaves: Row[]): Row[] {
  return [
    {
      type: "session",
      id: sessionId,
      version: 4,
      ...(inheritedThrough.length ? { inheritedThrough } : {}),
    },
    ...MESSAGES.map((entry) => ({
      type: "message",
      id: entry.id,
      parentId: entry.parentId,
      message: { role: entry.tokens ? "assistant" : "user", content: entry.id },
      tokens: entry.tokens,
    })),
    ...leaves,
  ];
}

const SWITCH_LEAF = { type: "leaf", id: "97c81933", parentId: "a2", targetId: "a2b" };
const REWIND_LEAF = { type: "leaf", id: "7d3f38f6", parentId: "97c81933", targetId: "a1" };

const LEGACY_FAMILY = [
  window("legacy-source", [], []),
  window("legacy-after-switch", ["a2"], [SWITCH_LEAF]),
  window("legacy-after-rewind", ["a2", "a2b"], [SWITCH_LEAF, REWIND_LEAF]),
];

const billedTokens = (rows: Row[]) =>
  selectBilledTranscriptEvents(rows).reduce(
    (total, row) => total + (typeof row.tokens === "number" ? row.tokens : 0),
    0,
  );

/**
 * The merge base reported 70 tokens for this history: 10 + 40 + 20, each turn once
 * across the three windows. Billing historically active paths must not recount a
 * turn that a copied window already billed.
 */
it("bills a legacy copied family exactly once per turn", () => {
  // Which window carries a turn is an internal split; the family total is the
  // reported number, and 70 is what the merge base reported for these rows.
  expect(LEGACY_FAMILY.map(billedTokens).reduce((sum, tokens) => sum + tokens, 0)).toBe(70);
});
