/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { computeFileMatches } from "./chat-sidebar-file-view.tsx";

describe("computeFileMatches", () => {
  it.each(["NFC", "NFD"] as const)(
    "matches file lines across %s content and the other normalization form query",
    (form) => {
      const canonical = (text: string) => text.normalize(form);
      const other = (text: string) => text.normalize(form === "NFC" ? "NFD" : "NFC");
      const content = [
        canonical("intro"),
        canonical("Café line"),
        canonical("Naïve line"),
        "plain",
      ].join("\n");
      expect(computeFileMatches(content, other("café"))).toEqual([2]);
      expect(computeFileMatches(content, other("naïve"))).toEqual([3]);
      expect(computeFileMatches(content, other("none"))).toEqual([]);
    },
  );

  it("keeps matching case-insensitive across Unicode forms", () => {
    const content = "Résumé\nnotes";
    expect(computeFileMatches(content, "RÉSUMÉ")).toEqual([1]);
    expect(computeFileMatches(content, "rÉsUmé")).toEqual([1]);
  });
});
