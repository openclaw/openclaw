import { describe, expect, it } from "vitest";
import {
  __testing,
  createBlockedCourseCreatorLiveCrawlReport,
  createCourseCreatorLiveCrawlPack,
  type CourseCreatorLiveCrawlRunner,
} from "./live-crawl.js";
import type { CourseCreatorResearchPackInput } from "./package.js";

const liveSearchPack = {
  schemaVersion: 1,
  sources: [
    {
      id: "live-search-01-exampleedu",
      title: "University extension herb gardening",
      url: "https://example.edu/extension/herb-gardening",
      publisher: "example.edu",
      tier: "A",
      credibilityScore: 92,
      license: "live-search-result-metadata",
      content:
        "Search result metadata for a university extension herb gardening source with enough content for validation.",
    },
    {
      id: "live-search-02-exampleorg",
      title: "Botanical garden herbs guide",
      url: "https://example.org/botanical/herbs",
      publisher: "example.org",
      tier: "A",
      credibilityScore: 88,
      license: "live-search-result-metadata",
      content:
        "Search result metadata for a botanical garden herb source with enough content for validation.",
    },
  ],
  claims: [
    {
      id: "claim-live-search-01-exampleedu",
      text: "The live search provider returned a university extension herb gardening candidate.",
      sourceIds: ["live-search-01-exampleedu"],
    },
  ],
} satisfies CourseCreatorResearchPackInput;

const successfulFetchRunner: CourseCreatorLiveCrawlRunner = async ({ source }) => ({
  sourceId: source.id,
  url: source.url,
  result: {
    finalUrl: source.url,
    status: 200,
    contentType: "text/html",
    extractor: "readability",
    fetchedAt: "2026-05-14T12:00:00.000Z",
    text:
      source.id === "live-search-01-exampleedu"
        ? "Beginner herb gardeners should place common culinary herbs where they receive steady sunlight, check soil moisture before watering, and harvest small amounts regularly. Short observation routines help learners notice plant stress before it becomes difficult to correct."
        : "Container herb lessons should ask learners to compare drainage, light exposure, and watering routines before choosing a planting location. Practice activities work best when learners record what changed after each harvest.",
  },
});

describe("Course Creator live crawl adapter", () => {
  it("turns live search source candidates into crawled source snapshots", async () => {
    const result = await createCourseCreatorLiveCrawlPack({
      topic: "Home herb gardening",
      researchPack: liveSearchPack,
      now: new Date("2026-05-14T12:00:00.000Z"),
      runFetch: successfulFetchRunner,
    });

    expect(result.report).toEqual(
      expect.objectContaining({
        status: "pass",
        requested: 2,
        fetched: 2,
        sourceIds: ["live-search-01-exampleedu", "live-search-02-exampleorg"],
      }),
    );
    expect(result.researchPack?.sources).toHaveLength(2);
    expect(result.researchPack?.sources[0]?.license).toBe(
      "live-search-result-metadata; live-page-extracted; semantic-claims-extracted",
    );
    expect(result.researchPack?.sources[0]?.content).toContain("Extractor: readability");
    expect(result.researchPack?.claims).toHaveLength(4);
    expect(result.researchPack?.claims[0]).toEqual(
      expect.objectContaining({
        id: "claim-semantic-live-search-01-exampleedu-1",
        sourceIds: ["live-search-01-exampleedu"],
        evidenceSpans: [
          expect.objectContaining({
            sourceId: "live-search-01-exampleedu",
            excerpt: expect.stringContaining("steady sunlight"),
          }),
        ],
      }),
    );
    expect(result.researchPack?.claims.map((claim) => claim.text).join("\n")).not.toContain(
      "was fetched and extracted",
    );
  });

  it("blocks when fewer than two pages are extracted", async () => {
    const result = await createCourseCreatorLiveCrawlPack({
      topic: "Home herb gardening",
      researchPack: liveSearchPack,
      now: new Date("2026-05-14T12:00:00.000Z"),
      runFetch: async ({ source }) => {
        if (source.id === "live-search-01-exampleedu") {
          return await successfulFetchRunner({
            source,
            maxChars: 12000,
          });
        }
        throw new Error("fetch failed");
      },
    });

    expect(result.researchPack).toBeUndefined();
    expect(result.report).toEqual(
      expect.objectContaining({
        status: "blocked",
        requested: 2,
        fetched: 1,
      }),
    );
    expect(result.report.failures).toContainEqual(
      expect.objectContaining({ sourceId: "live-search-02-exampleorg", error: "fetch failed" }),
    );
  });

  it("creates a blocked prerequisite report", () => {
    expect(
      createBlockedCourseCreatorLiveCrawlReport({
        requested: 0,
        crawledAt: "2026-05-14T12:00:00.000Z",
        error: "Live page crawl requires accepted live search sources first.",
      }),
    ).toEqual(
      expect.objectContaining({
        status: "blocked",
        requested: 0,
        fetched: 0,
      }),
    );
  });

  it("strips OpenClaw web_fetch wrappers before snapshotting page text", () => {
    expect(
      __testing.normalizeFetchedText(
        [
          '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>',
          "Source: Web Fetch",
          "---",
          "Wrapped page text",
          '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>',
        ].join("\n"),
      ),
    ).toBe("Wrapped page text");
  });

  it("filters non-instructional page text from semantic claims", () => {
    expect(
      __testing.extractSemanticSentences(
        "Cookie notice. Sign in to subscribe. Beginner herb gardeners should check soil moisture, choose a sunny location, and harvest small amounts regularly to support continued practice.",
      ),
    ).toEqual([
      "Beginner herb gardeners should check soil moisture, choose a sunny location, and harvest small amounts regularly to support continued practice.",
    ]);
  });
});
