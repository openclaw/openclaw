// Verifies security context visibility decisions.
import { describe, expect, it } from "vitest";
import {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
} from "./context-visibility.js";

describe("evaluateSupplementalContextVisibility", () => {
  it.each([
    [
      "reports why all mode keeps context",
      { mode: "all", kind: "history", senderAllowed: false },
      { include: true, reason: "mode_all" },
    ],
    [
      "reports quote override decisions",
      { mode: "allowlist_quote", kind: "quote", senderAllowed: false },
      { include: true, reason: "quote_override" },
    ],
    [
      "still drops non-quote context in allowlist_quote mode",
      { mode: "allowlist_quote", kind: "history", senderAllowed: false },
      { include: false, reason: "blocked" },
    ],
  ] as const)("%s", (_name, params, expected) => {
    expect(evaluateSupplementalContextVisibility(params)).toEqual(expected);
  });
});

describe("filterSupplementalContextItems", () => {
  it("filters blocked items and reports omission count", () => {
    const result = filterSupplementalContextItems({
      items: [
        { id: "allowed", senderAllowed: true },
        { id: "blocked", senderAllowed: false },
      ],
      mode: "allowlist",
      kind: "thread",
      isSenderAllowed: (item) => item.senderAllowed,
    });

    expect(result).toEqual({
      items: [{ id: "allowed", senderAllowed: true }],
      omitted: 1,
    });
  });
});
