import { describe, expect, it } from "vitest";
import {
  parseDoltSummaryDocument,
  prefixDoltSummaryFrontmatter,
  serializeDoltSummaryFrontmatter,
  validateDoltChildrenChronologicalOrder,
  validateDoltLineageEdgeLevels,
} from "./contract.js";

describe("serializeDoltSummaryFrontmatter", () => {
  it("renders canonical deterministic YAML", () => {
    const frontmatter = serializeDoltSummaryFrontmatter({
      summaryType: "leaf",
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      children: ["turn-1", "turn'2"],
      finalizedAtReset: false,
    });

    expect(frontmatter).toBe(
      [
        "---",
        "summary-type: leaf",
        "dates-covered: 1000|2000",
        "children: ['turn-1', 'turn''2']",
        "finalized-at-reset: false",
        "---",
      ].join("\n"),
    );
  });

  it("can omit children from serialized front-matter", () => {
    const frontmatter = serializeDoltSummaryFrontmatter(
      {
        summaryType: "leaf",
        datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
        children: ["turn-1", "turn-2"],
        finalizedAtReset: false,
      },
      { includeChildren: false },
    );

    expect(frontmatter).toBe(
      [
        "---",
        "summary-type: leaf",
        "dates-covered: 1000|2000",
        "finalized-at-reset: false",
        "---",
      ].join("\n"),
    );
  });
});

describe("parseDoltSummaryDocument", () => {
  it("parses strict front-matter and body", () => {
    const parsed = parseDoltSummaryDocument(
      [
        "---",
        "summary-type: bindle",
        "dates-covered: 100|300",
        "children: ['leaf-1', 'leaf-2']",
        "finalized-at-reset: true",
        "---",
        "Bindle body",
      ].join("\n"),
    );

    expect(parsed.frontmatter).toEqual({
      summaryType: "bindle",
      datesCovered: {
        startEpochMs: 100,
        endEpochMs: 300,
      },
      children: ["leaf-1", "leaf-2"],
      finalizedAtReset: true,
    });
    expect(parsed.body).toBe("Bindle body");
  });

  it("accepts summaries without children in front-matter", () => {
    const parsed = parseDoltSummaryDocument(
      [
        "---",
        "summary-type: leaf",
        "dates-covered: 100|300",
        "finalized-at-reset: false",
        "---",
        "Leaf body",
      ].join("\n"),
    );

    expect(parsed.frontmatter.children).toEqual([]);
    expect(parsed.body).toBe("Leaf body");
  });

  it("rejects malformed front-matter", () => {
    expect(() =>
      parseDoltSummaryDocument(
        [
          "---",
          "summary-type: leaf",
          "dates-covered: malformed",
          "children: ['turn-1']",
          "finalized-at-reset: false",
          "---",
        ].join("\n"),
      ),
    ).toThrow(/dates-covered/);
  });
});

describe("prefixDoltSummaryFrontmatter", () => {
  it("replaces an existing valid front-matter block deterministically", () => {
    const summary = prefixDoltSummaryFrontmatter({
      summary: [
        "---",
        "summary-type: leaf",
        "dates-covered: 1|2",
        "children: ['turn-old']",
        "finalized-at-reset: false",
        "---",
        "Old body",
      ].join("\n"),
      frontmatter: {
        summaryType: "leaf",
        datesCovered: { startEpochMs: 100, endEpochMs: 200 },
        children: ["turn-1", "turn-2"],
        finalizedAtReset: true,
      },
    });

    expect(summary).toContain("dates-covered: 100|200");
    expect(summary).toContain("children: ['turn-1', 'turn-2']");
    expect(summary).toContain("finalized-at-reset: true");
    expect(summary.endsWith("Old body")).toBe(true);
  });

  it("supports prefixing front-matter without children", () => {
    const summary = prefixDoltSummaryFrontmatter({
      summary: "Body only",
      frontmatter: {
        summaryType: "leaf",
        datesCovered: { startEpochMs: 100, endEpochMs: 200 },
        children: ["turn-1", "turn-2"],
        finalizedAtReset: false,
      },
      serializeOptions: { includeChildren: false },
    });

    expect(summary).toContain("summary-type: leaf");
    expect(summary).not.toContain("children:");
    expect(summary.endsWith("Body only")).toBe(true);
  });
});

describe("lineage validators", () => {
  it("enforces allowed parent/child level combinations", () => {
    expect(() =>
      validateDoltLineageEdgeLevels({
        parentLevel: "bindle",
        childLevel: "turn",
        parentPointer: "bindle-1",
        childPointer: "turn-1",
      }),
    ).toThrow(/can only reference leaf children/);
  });

  it("enforces chronological child ordering", () => {
    expect(() =>
      validateDoltChildrenChronologicalOrder({
        parentPointer: "leaf-1",
        children: [
          { pointer: "turn-2", eventTsMs: 200 },
          { pointer: "turn-1", eventTsMs: 100 },
        ],
      }),
    ).toThrow(/must be chronological/);
  });
});
