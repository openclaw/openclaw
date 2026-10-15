// Verifies security context visibility decisions.
import { describe, expect, it } from "vitest";
import {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
} from "./context-visibility.js";

describe("evaluateSupplementalContextVisibility", () => {
  it("reports why all mode keeps context", () => {
    expect(
      evaluateSupplementalContextVisibility({
        mode: "all",
        kind: "history",
        senderAllowed: false,
      }),
    ).toEqual({
      include: true,
      reason: "mode_all",
    });
  });

  it("reports quote override decisions", () => {
    expect(
      evaluateSupplementalContextVisibility({
        mode: "allowlist_quote",
        kind: "quote",
        senderAllowed: false,
      }),
    ).toEqual({
      include: true,
      reason: "quote_override",
    });
  });

  it("still drops non-quote context in allowlist_quote mode", () => {
    expect(
      evaluateSupplementalContextVisibility({
        mode: "allowlist_quote",
        kind: "history",
        senderAllowed: false,
      }),
    ).toEqual({ include: false, reason: "blocked" });
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
