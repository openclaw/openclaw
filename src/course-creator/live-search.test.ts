import { describe, expect, it } from "vitest";
import {
  __testing,
  createCourseCreatorLiveSearchPack,
  type CourseCreatorLiveSearchRunner,
} from "./live-search.js";

const successfulRunner: CourseCreatorLiveSearchRunner = async ({ query }) => ({
  provider: "duckduckgo",
  result: {
    query,
    provider: "duckduckgo",
    count: 3,
    results: [
      {
        title: "University extension herb gardening",
        url: "https://example.edu/extension/herb-gardening",
        snippet:
          "An extension source explaining beginner herb gardening planning, watering, sunlight, and harvest routines.",
        siteName: "example.edu",
      },
      {
        title: "Botanical garden herbs guide",
        url: "https://example.org/botanical/herbs",
        description:
          "A botanical garden source with container herb activities, observation prompts, and learner practice ideas.",
        siteName: "example.org",
      },
      {
        title: "Herb gardening assessment reference",
        url: "https://example.com/herbs/assessment",
        snippets: [
          "A course reference describing answer-key checks, practice rubrics, and completion evidence.",
        ],
        siteName: "example.com",
      },
    ],
  },
});

describe("Course Creator live search adapter", () => {
  it("normalizes live search results into a source-backed research pack", async () => {
    const result = await createCourseCreatorLiveSearchPack({
      topic: "Home herb gardening",
      now: new Date("2026-05-14T12:00:00.000Z"),
      runSearch: successfulRunner,
    });

    expect(result.report).toEqual(
      expect.objectContaining({
        status: "pass",
        provider: "duckduckgo",
        query: "Home herb gardening credible beginner course sources",
        resultCount: 3,
      }),
    );
    expect(result.researchPack?.sources).toHaveLength(3);
    expect(result.researchPack?.sources[0]).toEqual(
      expect.objectContaining({
        id: "live-search-01-exampleedu",
        tier: "A",
        credibilityScore: 92,
        license: "live-search-result-metadata",
      }),
    );
    expect(result.researchPack?.claims).toHaveLength(3);
    expect(result.report.sourceIds).toEqual([
      "live-search-01-exampleedu",
      "live-search-02-exampleorg",
      "live-search-03-examplecom",
    ]);
  });

  it("returns a blocked report when the provider reports missing credentials", async () => {
    const result = await createCourseCreatorLiveSearchPack({
      topic: "Home herb gardening",
      now: new Date("2026-05-14T12:00:00.000Z"),
      runSearch: async () => ({
        provider: "brave",
        result: {
          error: "missing_brave_api_key",
          message: "web_search (brave) needs a Brave Search API key.",
        },
      }),
    });

    expect(result.researchPack).toBeUndefined();
    expect(result.report).toEqual(
      expect.objectContaining({
        status: "blocked",
        provider: "brave",
        resultCount: 0,
        error: "web_search (brave) needs a Brave Search API key.",
      }),
    );
    expect(result.report.requiredHumanActions).toContain(
      "Configure a working web_search provider and credentials if required.",
    );
  });

  it("strips OpenClaw external-content wrappers before snapshotting source text", () => {
    expect(
      __testing.normalizeSearchResults({
        results: [
          {
            title: [
              '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>',
              "Source: Web Search",
              "---",
              "Wrapped Title",
              '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>',
            ].join("\n"),
            url: "https://example.edu/wrapped",
            snippet: "plain snippet",
          },
        ],
      })[0]?.title,
    ).toBe("Wrapped Title");
  });
});
