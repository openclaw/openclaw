// Citation control marker tests cover stripping unsupported citation markers.
import { describe, expect, it } from "vitest";
import { stripUnsupportedCitationControlMarkers } from "./citation-control-markers.js";

describe("stripUnsupportedCitationControlMarkers", () => {
  it("preserves unrelated trailing whitespace", () => {
    expect(stripUnsupportedCitationControlMarkers("hard break  \nnext")).toBe("hard break  \nnext");
  });
});
