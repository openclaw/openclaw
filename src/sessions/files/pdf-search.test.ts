import { describe, it, expect } from "vitest";
import { searchText } from "./pdf-search.js";

describe("searchText", () => {
  const content = `Line 1: Revenue growth
Line 2: Sales increased
Line 3: Revenue was strong
Line 4: Growth continues`;

  it("finds matches with single token", () => {
    const matches = searchText(content, "Revenue");
    expect(matches).toHaveLength(2);
    expect(matches[0].snippet).toContain("Revenue");
  });

  it("finds matches with multiple tokens (AND logic)", () => {
    const matches = searchText(content, "revenue growth");
    expect(matches).toHaveLength(1);
    expect(matches[0].snippet).toContain("Revenue growth");
  });

  it("returns empty if no match", () => {
    const matches = searchText(content, "nonexistent");
    expect(matches).toHaveLength(0);
  });

  it("includes context lines", () => {
    const matches = searchText(content, "Sales");
    expect(matches[0].context).toContain("Sales");
  });

  it("limits results", () => {
    const matches = searchText(content, "Revenue", { maxResults: 1 });
    expect(matches).toHaveLength(1);
  });
});
