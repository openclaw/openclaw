/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { computeFileMatches } from "./chat-sidebar-file-view.tsx";

describe("computeFileMatches", () => {
  it.each(["NFC", "NFD"] as const)(
    "matches file lines across %s and the other normalization form",
    (form) => {
      const content = ["intro", "Café line", "Naïve line", "plain"].join("\n");
      const equivalent = (text: string) => text.normalize(form === "NFC" ? "NFD" : "NFC");
      expect(computeFileMatches(content, equivalent("café"))).toEqual([2]);
      expect(computeFileMatches(content, equivalent("naïve"))).toEqual([3]);
      expect(computeFileMatches(content, equivalent("none"))).toEqual([]);
    },
  );

  it("keeps matching case-insensitive across Unicode forms", () => {
    const content = "Résumé\nnotes";
    expect(computeFileMatches(content, "RÉSUMÉ")).toEqual([1]);
    expect(computeFileMatches(content, "rÉsUmé")).toEqual([1]);
  });
});
