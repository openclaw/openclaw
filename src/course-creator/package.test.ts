import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCourseCreatorLiveCrawlPack,
  type CourseCreatorLiveCrawlRunner,
} from "./live-crawl.js";
import {
  createCourseCreatorLiveSearchPack,
  type CourseCreatorLiveSearchRunner,
} from "./live-search.js";
import {
  createCourseCreatorPackage,
  readCourseCreatorApprovalEvidence,
  readCourseCreatorLiveMoodleStagingReport,
  slugifyCourseTopic,
  type CourseCreatorApprovalEvidence,
  type CourseCreatorLiveMoodleStagingReport,
  validateCourseCreatorArtifacts,
  verifyCourseCreatorClaims,
} from "./package.js";

const successfulLiveSearchRunner: CourseCreatorLiveSearchRunner = async ({ query }) => ({
  provider: "duckduckgo",
  result: {
    query,
    provider: "duckduckgo",
    count: 2,
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
        snippet:
          "A botanical garden source with container herb activities, observation prompts, and learner practice ideas.",
        siteName: "example.org",
      },
    ],
  },
});

const successfulLiveCrawlRunner: CourseCreatorLiveCrawlRunner = async ({ source }) => ({
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

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-course-creator-"));
}

function writeResearchPack(root: string): string {
  const packPath = path.join(root, "research-pack.json");
  fs.writeFileSync(
    packPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sources: [
          {
            id: "university-extension-basics",
            title: "University extension herb gardening basics",
            url: "https://example.edu/extension/herb-gardening-basics",
            publisher: "Example University Extension",
            tier: "A",
            credibilityScore: 92,
            license: "open educational fixture",
            content:
              "Herb gardening courses should teach learners to match plant selection, watering, light, and harvest practices to the growing environment. This source record is deterministic test content representing an approved institutional source snapshot.",
          },
          {
            id: "botanical-garden-practice",
            title: "Botanical garden container herb practice",
            url: "https://example.org/botanical/container-herbs",
            publisher: "Example Botanical Garden",
            tier: "A",
            credibilityScore: 90,
            license: "open educational fixture",
            content:
              "Container herb lessons should include practice activities, observation routines, and simple checks for soil moisture and sunlight. This source record is deterministic test content representing a second approved source snapshot.",
          },
          {
            id: "cooperative-extension-harvest",
            title: "Cooperative extension harvest guidance",
            url: "https://example.gov/cooperative/herb-harvest",
            publisher: "Example Cooperative Extension",
            tier: "B",
            credibilityScore: 88,
            license: "open educational fixture",
            content:
              "Harvest guidance for beginner herb courses should explain how frequent, modest harvesting supports practice and learner confidence. This source record is deterministic test content representing a third approved source snapshot.",
          },
        ],
        claims: [
          {
            id: "claim-match-plant-care",
            text: "Beginner herb gardening learners should match plant selection, watering, light, and harvest practices to the growing environment.",
            sourceIds: ["university-extension-basics"],
          },
          {
            id: "claim-practice-routines",
            text: "Container herb lessons should include practice activities, observation routines, and checks for soil moisture and sunlight.",
            sourceIds: ["botanical-garden-practice"],
          },
          {
            id: "claim-modest-harvesting",
            text: "Frequent, modest harvesting can support beginner practice and learner confidence.",
            sourceIds: ["cooperative-extension-harvest"],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return packPath;
}

function liveMoodleStagingReport(): CourseCreatorLiveMoodleStagingReport {
  return {
    status: "pass",
    checkedAt: "2026-05-14T12:00:00.000Z",
    courseId: "moodle-course-4242",
    courseUrl: "https://moodle.example.test/course/view.php?id=4242",
    events: [
      {
        action: "create_hidden_course",
        status: "pass",
        evidence: "Created hidden Moodle course 4242.",
      },
      {
        action: "upload_lessons",
        status: "pass",
        evidence: "Uploaded generated module and lesson artifacts.",
      },
      {
        action: "create_quiz",
        status: "pass",
        evidence: "Created quiz with answer key metadata.",
      },
    ],
    smokeTest: {
      status: "pass",
      checks: [
        {
          action: "student_preview_course",
          status: "pass",
          evidence: "Preview learner opened the hidden course.",
        },
        {
          action: "submit_quiz",
          status: "pass",
          evidence: "Preview learner submitted quiz and saw expected scoring.",
        },
      ],
    },
    recovery: {
      status: "pass",
      exportPath: "moodle-backup://course-4242/backup.mbz",
      rollbackEvidence: "Rollback dry-run kept the course hidden and restorable.",
    },
    blockers: ["public-publish-canary-approval"],
    checklist: [
      {
        id: "hidden-course",
        status: "present",
        source: "moodle",
        message: "Course visibility is hidden.",
      },
      {
        id: "student-smoke",
        status: "present",
        source: "moodle",
        message: "Preview learner smoke passed.",
      },
      {
        id: "rollback-export",
        status: "present",
        source: "moodle",
        message: "Export and rollback proof exists.",
      },
    ],
    requiredHumanActions: [
      "Attach public publish canary approval evidence before any visibility change.",
    ],
    reason: "Live Moodle hidden staging certification passed.",
  };
}

function writeLiveMoodleStagingReport(root: string): string {
  const reportPath = path.join(root, "live-moodle-staging-report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ schemaVersion: 1, ...liveMoodleStagingReport() }, null, 2)}\n`,
    "utf8",
  );
  return reportPath;
}

function highRiskApprovalEvidence(
  topic = "Clinical ventilator certification",
): CourseCreatorApprovalEvidence {
  return {
    schemaVersion: 1,
    scope: "high_risk_course_review",
    decision: "approved",
    topic,
    reviewerName: "Example Clinical Reviewer",
    reviewerRole: "Credentialed subject-matter reviewer",
    approvedAt: "2026-05-14T11:00:00.000Z",
    expiresAt: "2026-06-14T11:00:00.000Z",
    evidence:
      "Reviewed source-backed draft for gated staging only; public release remains blocked.",
    limitations: [
      "Does not authorize public publish.",
      "Does not replace local law or policy review.",
    ],
  };
}

function writeApprovalEvidence(root: string, topic = "Clinical ventilator certification"): string {
  const approvalPath = path.join(root, "approval-evidence.json");
  fs.writeFileSync(
    approvalPath,
    `${JSON.stringify(highRiskApprovalEvidence(topic), null, 2)}\n`,
    "utf8",
  );
  return approvalPath;
}

describe("Course Creator package", () => {
  it("creates a validated topic-only package that fails closed before sources exist", () => {
    const result = createCourseCreatorPackage({
      topic: "Beginner sourdough bread baking",
      outputRoot: makeTempRoot(),
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.slug).toBe("beginner-sourdough-bread-baking");
    expect(result.status).toBe("blocked");
    expect(result.riskTier).toBe("low");
    expect(result.researchMode).toBe("none");
    expect(result.claims).toEqual([]);
    expect(result.qaReport.status).toBe("blocked");
    expect(result.nextBuildGap.id).toBe("research-source-snapshots");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-gate", status: "blocked" }),
        expect.objectContaining({ id: "fact-gate", status: "blocked" }),
        expect.objectContaining({ id: "qa-gate", status: "blocked" }),
        expect.objectContaining({ id: "publish-gate", status: "blocked" }),
      ]),
    );
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
    expect(result.artifacts.map((item) => item.id)).toEqual([
      "course-yaml",
      "source-pack",
      "curriculum",
      "lesson-01",
      "quiz-01",
      "claim-map",
      "qa-report",
      "quality-policy-report",
      "content-generation-report",
      "publish-report",
      "self-improvement-report",
      "next-build-gap",
    ]);
  });

  it("writes fixture source snapshots and advances the source gate", () => {
    const result = createCourseCreatorPackage({
      topic: "Beginner sourdough bread baking",
      outputRoot: makeTempRoot(),
      researchMode: "fixture",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.researchMode).toBe("fixture");
    expect(result.sources).toHaveLength(3);
    expect(result.claims).toHaveLength(3);
    expect(result.qaReport.status).toBe("pass");
    expect(result.qaReport.score).toBeGreaterThanOrEqual(90);
    expect(result.qaReport.criticalFailures).toEqual([]);
    expect(result.nextBuildGap.id).toBe("staging-publish-adapter");
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "source-gate", status: "pass", score: 90 }),
    );
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "fact-gate", status: "pass", score: 95 }),
    );
    expect(result.gates).toContainEqual(expect.objectContaining({ id: "qa-gate", status: "pass" }));
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });

    const sourcePackPath = result.artifacts.find((item) => item.id === "source-pack")?.path;
    expect(sourcePackPath).toBeDefined();
    if (!sourcePackPath) {
      throw new Error("source-pack artifact missing from fixture test");
    }
    const sourcePack = JSON.parse(fs.readFileSync(sourcePackPath, "utf8")) as {
      status?: string;
      mode?: string;
      sources?: Array<{ id?: string; snapshotPath?: string; checksum?: string }>;
    };
    expect(sourcePack.status).toBe("pass");
    expect(sourcePack.mode).toBe("fixture");
    expect(sourcePack.sources).toHaveLength(3);
    for (const source of sourcePack.sources ?? []) {
      expect(source.snapshotPath).toBeTruthy();
      expect(source.checksum).toMatch(/^[a-f0-9]{64}$/u);
      expect(fs.existsSync(source.snapshotPath ?? "")).toBe(true);
    }

    const claimMapPath = result.artifacts.find((item) => item.id === "claim-map")?.path;
    expect(claimMapPath).toBeDefined();
    if (!claimMapPath) {
      throw new Error("claim-map artifact missing from fixture test");
    }
    const claimMap = JSON.parse(fs.readFileSync(claimMapPath, "utf8")) as {
      status?: string;
      verification?: { status?: string; verified?: number; unsupported?: number };
      claims?: Array<{ status?: string; sourceIds?: string[]; evidence?: unknown[] }>;
    };
    expect(claimMap.status).toBe("pass");
    expect(claimMap.verification).toEqual(
      expect.objectContaining({ status: "pass", verified: 3, unsupported: 0 }),
    );
    expect(claimMap.claims).toHaveLength(3);
    expect(
      claimMap.claims?.every(
        (claim) =>
          claim.status === "verified" &&
          (claim.sourceIds?.length ?? 0) > 0 &&
          claim.evidence?.length === claim.sourceIds?.length,
      ),
    ).toBe(true);

    const qaReportPath = result.artifacts.find((item) => item.id === "qa-report")?.path;
    expect(qaReportPath).toBeDefined();
    if (!qaReportPath) {
      throw new Error("qa-report artifact missing from fixture test");
    }
    const qaReport = JSON.parse(fs.readFileSync(qaReportPath, "utf8")) as {
      status?: string;
      score?: number;
      passThreshold?: number;
      criticalFailures?: string[];
      rubric?: Array<{ id?: string; status?: string; score?: number }>;
    };
    expect(qaReport.status).toBe("pass");
    expect(qaReport.score).toBeGreaterThanOrEqual(qaReport.passThreshold ?? 90);
    expect(qaReport.criticalFailures).toEqual([]);
    expect(qaReport.rubric).toContainEqual(
      expect.objectContaining({ id: "factual-accuracy", status: "pass", score: 10 }),
    );
  });

  it("writes mocked Moodle staging, smoke, and recovery evidence", () => {
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "fixture",
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.publishMode).toBe("mock_moodle_staging");
    expect(result.publishReport).toEqual(
      expect.objectContaining({
        status: "pass",
        target: "moodle",
        adapter: "mock",
        visibility: "hidden",
        publicPublishAllowed: false,
      }),
    );
    expect(result.publishReport.smokeTest.status).toBe("pass");
    expect(result.publishReport.recovery.status).toBe("pass");
    expect(result.nextBuildGap.id).toBe("live-research-adapter");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "publish-gate", status: "pass" }),
        expect.objectContaining({ id: "smoke-gate", status: "pass" }),
        expect.objectContaining({ id: "recovery-gate", status: "pass" }),
        expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
      ]),
    );
    expect(result.artifacts.map((item) => item.id)).toContain("publish-evidence");
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });

    const publishReportPath = result.artifacts.find((item) => item.id === "publish-report")?.path;
    expect(publishReportPath).toBeDefined();
    if (!publishReportPath) {
      throw new Error("publish-report artifact missing from mocked staging test");
    }
    const publishReport = JSON.parse(fs.readFileSync(publishReportPath, "utf8")) as {
      status?: string;
      evidencePath?: string;
      smokeTest?: { status?: string; checks?: unknown[] };
      recovery?: { status?: string; exportPath?: string | null };
    };
    expect(publishReport.status).toBe("pass");
    expect(publishReport.smokeTest).toEqual(
      expect.objectContaining({ status: "pass", checks: expect.any(Array) }),
    );
    expect(publishReport.recovery).toEqual(
      expect.objectContaining({ status: "pass", exportPath: expect.any(String) }),
    );
    expect(fs.existsSync(publishReport.evidencePath ?? "")).toBe(true);
  });

  it("snapshots configured research packs through the full local gate path", () => {
    const outputRoot = makeTempRoot();
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot,
      researchMode: "research_pack",
      researchPackPath: writeResearchPack(outputRoot),
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.researchMode).toBe("research_pack");
    expect(result.sources).toHaveLength(3);
    expect(result.claims).toHaveLength(3);
    expect(result.qaReport.status).toBe("pass");
    expect(result.publishReport.status).toBe("pass");
    expect(result.publishReport.publicPublishAllowed).toBe(false);
    expect(result.nextBuildGap.id).toBe("automated-search-crawl-adapter");
    expect(result.requiredHumanActions).toContain(
      "Replace per-course research pack input with automated search/crawl before topic-only production.",
    );
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-gate", status: "pass" }),
        expect.objectContaining({ id: "fact-gate", status: "pass" }),
        expect.objectContaining({ id: "qa-gate", status: "pass" }),
        expect.objectContaining({ id: "publish-gate", status: "pass" }),
        expect.objectContaining({ id: "smoke-gate", status: "pass" }),
        expect.objectContaining({ id: "recovery-gate", status: "pass" }),
        expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
      ]),
    );
    expect(
      result.sources.every(
        (source) =>
          source.credibilityScore >= 85 &&
          fs.existsSync(source.snapshotPath) &&
          source.checksum.match(/^[a-f0-9]{64}$/u),
      ),
    ).toBe(true);
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("writes quality policy evidence for source, copyright, contradiction, accessibility, and assessment checks", () => {
    const outputRoot = makeTempRoot();
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot,
      researchMode: "research_pack",
      researchPackPath: writeResearchPack(outputRoot),
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.qualityPolicyReport.status).toBe("pass");
    expect(result.qualityPolicyReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-credibility-scoring", status: "pass" }),
        expect.objectContaining({ id: "license-copyright-screening", status: "pass" }),
        expect.objectContaining({ id: "contradiction-detection", status: "pass" }),
        expect.objectContaining({ id: "accessibility-mobile-readiness", status: "pass" }),
        expect.objectContaining({ id: "assessment-quality", status: "pass" }),
      ]),
    );
    const qualityPolicyPath = result.artifacts.find(
      (item) => item.id === "quality-policy-report",
    )?.path;
    expect(qualityPolicyPath).toBeDefined();
    if (!qualityPolicyPath) {
      throw new Error("quality-policy-report artifact missing from test result");
    }
    const qualityPolicy = JSON.parse(fs.readFileSync(qualityPolicyPath, "utf8")) as {
      status?: string;
      checks?: Array<{ id?: string; status?: string }>;
    };
    expect(qualityPolicy.status).toBe("pass");
    expect(qualityPolicy.checks).toContainEqual(
      expect.objectContaining({ id: "assessment-quality", status: "pass" }),
    );
  });

  it("blocks QA when quality policy detects unsafe licensing and contradictory claims", () => {
    const outputRoot = makeTempRoot();
    const packPath = writeResearchPack(outputRoot);
    const pack = JSON.parse(fs.readFileSync(packPath, "utf8")) as {
      sources: Array<{ license: string }>;
      claims: Array<{ id: string; text: string; sourceIds: string[] }>;
    };
    pack.sources[0].license = "All rights reserved";
    pack.claims = [
      {
        id: "claim-water-daily",
        text: "Beginner herb gardeners should water container herbs daily during routine practice.",
        sourceIds: ["university-extension-basics"],
      },
      {
        id: "claim-do-not-water-daily",
        text: "Beginner herb gardeners should not water container herbs daily during routine practice.",
        sourceIds: ["botanical-garden-practice"],
      },
    ];
    fs.writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot,
      researchMode: "research_pack",
      researchPackPath: packPath,
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.qualityPolicyReport.status).toBe("blocked");
    expect(result.qualityPolicyReport.criticalFailures).toEqual(
      expect.arrayContaining(["license-copyright-screening", "contradiction-detection"]),
    );
    expect(result.qaReport.status).toBe("blocked");
    expect(result.publishReport.status).toBe("blocked");
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "qa-gate", status: "blocked" }),
    );
  });

  it("runs mocked search/crawl from topic-only input through the full local gate path", () => {
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "mock_search_crawl",
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.researchMode).toBe("mock_search_crawl");
    expect(result.sources).toHaveLength(3);
    expect(result.sources.map((source) => source.url)).toEqual([
      "mock-search://course-creator/home-herb-gardening/institutional-guide",
      "mock-search://course-creator/home-herb-gardening/practice-standard",
      "mock-search://course-creator/home-herb-gardening/assessment-reference",
    ]);
    expect(result.claims).toHaveLength(3);
    expect(result.qaReport.status).toBe("pass");
    expect(result.publishReport.status).toBe("pass");
    expect(result.publishReport.publicPublishAllowed).toBe(false);
    expect(result.nextBuildGap.id).toBe("live-search-provider-adapter");
    expect(result.requiredHumanActions).toContain(
      "Replace mocked search/crawl with a live search provider before production.",
    );
    expect(result.publishReport.blockers).toContain("live-search-provider-adapter");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-gate", status: "pass" }),
        expect.objectContaining({ id: "fact-gate", status: "pass" }),
        expect.objectContaining({ id: "qa-gate", status: "pass" }),
        expect.objectContaining({ id: "publish-gate", status: "pass" }),
        expect.objectContaining({ id: "smoke-gate", status: "pass" }),
        expect.objectContaining({ id: "recovery-gate", status: "pass" }),
        expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
      ]),
    );
    expect(
      result.sources.every(
        (source) =>
          source.credibilityScore >= 85 &&
          fs.existsSync(source.snapshotPath) &&
          source.checksum.match(/^[a-f0-9]{64}$/u),
      ),
    ).toBe(true);
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("snapshots live search source candidates through the full local gate path", async () => {
    const liveSearch = await createCourseCreatorLiveSearchPack({
      topic: "Home herb gardening",
      now: new Date("2026-05-14T12:00:00.000Z"),
      runSearch: successfulLiveSearchRunner,
    });
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "live_search",
      researchPackInput: liveSearch.researchPack,
      liveSearchReport: liveSearch.report,
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.researchMode).toBe("live_search");
    expect(result.liveSearchReport).toEqual(expect.objectContaining({ status: "pass" }));
    expect(result.sources).toHaveLength(2);
    expect(result.claims).toHaveLength(2);
    expect(result.qaReport.status).toBe("pass");
    expect(result.publishReport.status).toBe("pass");
    expect(result.publishReport.publicPublishAllowed).toBe(false);
    expect(result.nextBuildGap.id).toBe("live-page-crawl-content-extraction");
    expect(result.requiredHumanActions).toContain(
      "Add live page crawl/content extraction before production course generation.",
    );
    expect(result.publishReport.blockers).toContain("live-page-crawl-content-extraction");
    expect(result.artifacts.map((item) => item.id)).toContain("live-search-report");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-gate", status: "pass" }),
        expect.objectContaining({ id: "fact-gate", status: "pass" }),
        expect.objectContaining({ id: "qa-gate", status: "pass" }),
        expect.objectContaining({ id: "publish-gate", status: "pass" }),
        expect.objectContaining({ id: "smoke-gate", status: "pass" }),
        expect.objectContaining({ id: "recovery-gate", status: "pass" }),
        expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
      ]),
    );
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("snapshots live crawled pages through the full local gate path", async () => {
    const liveSearch = await createCourseCreatorLiveSearchPack({
      topic: "Home herb gardening",
      now: new Date("2026-05-14T12:00:00.000Z"),
      runSearch: successfulLiveSearchRunner,
    });
    if (!liveSearch.researchPack) {
      throw new Error("live search test setup did not produce a research pack");
    }
    const liveCrawl = await createCourseCreatorLiveCrawlPack({
      topic: "Home herb gardening",
      researchPack: liveSearch.researchPack,
      now: new Date("2026-05-14T12:00:00.000Z"),
      runFetch: successfulLiveCrawlRunner,
    });
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "live_search",
      researchPackInput: liveCrawl.researchPack,
      liveSearchReport: liveSearch.report,
      liveCrawlReport: liveCrawl.report,
      publishMode: "mock_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.researchMode).toBe("live_search");
    expect(result.liveCrawlReport).toEqual(expect.objectContaining({ status: "pass" }));
    expect(result.sources).toHaveLength(2);
    expect(result.claims).toHaveLength(4);
    expect(result.claims[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("steady sunlight"),
        evidenceSpans: [
          expect.objectContaining({
            sourceId: "live-search-01-exampleedu",
            excerpt: expect.stringContaining("steady sunlight"),
          }),
        ],
      }),
    );
    expect(result.contentGenerationReport).toEqual(
      expect.objectContaining({
        status: "pass",
        mode: "multi_module_course",
        moduleCount: 2,
        lessonCount: 2,
        sourceClaimCount: 4,
        quizQuestionCount: 3,
      }),
    );
    expect(result.qaReport.status).toBe("pass");
    expect(result.publishReport.status).toBe("pass");
    expect(result.nextBuildGap.id).toBe("live-moodle-staging-certification");
    expect(result.requiredHumanActions).toContain(
      "Configure and certify live Moodle staging before production publishing.",
    );
    expect(result.publishReport.blockers).toContain("live-moodle-staging-certification");
    expect(result.artifacts.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "module-01",
        "module-02",
        "lesson-01",
        "lesson-02",
        "live-search-report",
        "live-crawl-report",
        "content-generation-report",
        "publish-evidence",
      ]),
    );
    const lessonPath = result.artifacts.find((item) => item.id === "lesson-01")?.path;
    const quizPath = result.artifacts.find((item) => item.id === "quiz-01")?.path;
    if (!lessonPath || !quizPath) {
      throw new Error("semantic lesson artifacts missing from test result");
    }
    const lesson = fs.readFileSync(lessonPath, "utf8");
    expect(lesson).toContain("Status: semantic-source-claim-backed instructional lesson.");
    expect(lesson).toContain("Module: module-01");
    expect(lesson).toContain("Evidence excerpt:");
    expect(lesson).toContain("Guided Practice");
    const quiz = JSON.parse(fs.readFileSync(quizPath, "utf8")) as {
      status?: string;
      questions?: Array<{ explanation?: string; evidenceSourceIds?: string[] }>;
    };
    expect(quiz.status).toBe("draft");
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions?.[0]?.explanation).toContain("steady sunlight");
    expect(quiz.questions?.[0]?.evidenceSourceIds).toEqual(["live-search-01-exampleedu"]);
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("certifies live Moodle staging evidence while keeping public publish blocked", async () => {
    const liveSearch = await createCourseCreatorLiveSearchPack({
      topic: "Home herb gardening",
      now: new Date("2026-05-14T12:00:00.000Z"),
      runSearch: successfulLiveSearchRunner,
    });
    if (!liveSearch.researchPack) {
      throw new Error("live search test setup did not produce a research pack");
    }
    const liveCrawl = await createCourseCreatorLiveCrawlPack({
      topic: "Home herb gardening",
      researchPack: liveSearch.researchPack,
      now: new Date("2026-05-14T12:00:00.000Z"),
      runFetch: successfulLiveCrawlRunner,
    });
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "live_search",
      researchPackInput: liveCrawl.researchPack,
      liveSearchReport: liveSearch.report,
      liveCrawlReport: liveCrawl.report,
      liveMoodleStagingReport: liveMoodleStagingReport(),
      publishMode: "live_moodle_staging",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.publishReport).toEqual(
      expect.objectContaining({
        status: "pass",
        adapter: "live",
        visibility: "hidden",
        courseId: "moodle-course-4242",
        publicPublishAllowed: false,
      }),
    );
    expect(result.nextBuildGap.id).toBe("public-publish-canary-approval");
    expect(result.requiredHumanActions).toContain(
      "Attach public publish canary approval evidence before any visibility change.",
    );
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "publish-gate",
          status: "pass",
          reason: expect.stringContaining("Live Moodle staging"),
        }),
        expect.objectContaining({
          id: "public-publish-gate",
          status: "blocked",
          reason: expect.stringContaining("canary approval"),
        }),
      ]),
    );
    expect(result.artifacts.map((item) => item.id)).toEqual(
      expect.arrayContaining(["live-moodle-staging-report", "publish-evidence", "publish-report"]),
    );
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("reads and rejects invalid live Moodle staging report files", () => {
    const outputRoot = makeTempRoot();
    const reportPath = writeLiveMoodleStagingReport(outputRoot);
    expect(readCourseCreatorLiveMoodleStagingReport(reportPath)).toEqual(
      expect.objectContaining({
        status: "pass",
        courseId: "moodle-course-4242",
      }),
    );

    const invalidPath = path.join(outputRoot, "invalid-live-moodle-staging-report.json");
    fs.writeFileSync(
      invalidPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          ...liveMoodleStagingReport(),
          smokeTest: { status: "blocked", checks: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(() => readCourseCreatorLiveMoodleStagingReport(invalidPath)).toThrow(
      /requires passing smoke checks/u,
    );
  });

  it("keeps failed live search runs blocked with human recovery actions", () => {
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "live_search",
      liveSearchReport: {
        status: "blocked",
        provider: "brave",
        query: "Home herb gardening credible beginner course sources",
        resultCount: 0,
        sourceIds: [],
        searchedAt: "2026-05-14T12:00:00.000Z",
        error: "missing_brave_api_key",
        requiredHumanActions: ["Configure a working web_search provider and credentials."],
      },
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.sources).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.nextBuildGap.id).toBe("live-search-provider-configuration");
    expect(result.requiredHumanActions).toContain(
      "Configure a working web_search provider and rerun live source discovery.",
    );
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-gate", status: "blocked" }),
        expect.objectContaining({ id: "fact-gate", status: "blocked" }),
        expect.objectContaining({ id: "qa-gate", status: "blocked" }),
      ]),
    );
    expect(result.artifacts.map((item) => item.id)).toContain("live-search-report");
    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "pass",
      missing: [],
      checksumMismatches: [],
    });
  });

  it("rejects weak research packs before source-gate proof", () => {
    const outputRoot = makeTempRoot();
    const packPath = writeResearchPack(outputRoot);
    const pack = JSON.parse(fs.readFileSync(packPath, "utf8")) as {
      sources: Array<{ credibilityScore: number }>;
    };
    pack.sources[0].credibilityScore = 40;
    fs.writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

    expect(() =>
      createCourseCreatorPackage({
        topic: "Home herb gardening",
        outputRoot,
        researchMode: "research_pack",
        researchPackPath: packPath,
        now: new Date("2026-05-14T12:00:00.000Z"),
      }),
    ).toThrow(/credibilityScore must be at least 85/u);
  });

  it("fails claim verification when a claim references a missing source", () => {
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      researchMode: "fixture",
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    const [claim] = result.claims;
    expect(claim).toBeDefined();
    if (!claim) {
      throw new Error("fixture claim missing from test setup");
    }

    expect(
      verifyCourseCreatorClaims(
        [{ ...claim, sourceIds: ["missing-source"], evidence: [] }],
        result.sources,
      ),
    ).toEqual({
      status: "fail",
      verified: 0,
      unsupported: 1,
      missingSourceIds: ["missing-source"],
    });
  });

  it("keeps high-risk topics in draft-only mode with approval evidence as the next gap", () => {
    const result = createCourseCreatorPackage({
      topic: "Clinical ventilator certification",
      outputRoot: makeTempRoot(),
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.status).toBe("draft_only");
    expect(result.riskTier).toBe("high");
    expect(result.nextBuildGap.id).toBe("high-risk-approval-evidence");
    expect(result.requiredHumanActions).toContain(
      "Attach explicit expert or human approval evidence before public release.",
    );
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "risk-gate", status: "blocked" }),
    );
  });

  it("accepts high-risk approval evidence for gated staging without allowing public publish", () => {
    const outputRoot = makeTempRoot();
    const approvalPath = writeApprovalEvidence(outputRoot);

    expect(readCourseCreatorApprovalEvidence(approvalPath)).toEqual(
      expect.objectContaining({
        scope: "high_risk_course_review",
        decision: "approved",
      }),
    );

    const result = createCourseCreatorPackage({
      topic: "Clinical ventilator certification",
      outputRoot,
      researchMode: "fixture",
      publishMode: "mock_moodle_staging",
      approvalEvidencePath: approvalPath,
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.status).toBe("draft_only");
    expect(result.approvalEvidence).toEqual(
      expect.objectContaining({ scope: "high_risk_course_review", decision: "approved" }),
    );
    expect(result.publishReport.status).toBe("pass");
    expect(result.publishReport.publicPublishAllowed).toBe(false);
    expect(result.nextBuildGap.id).toBe("live-research-adapter");
    expect(result.requiredHumanActions).not.toContain(
      "Attach explicit expert or human approval evidence before public release.",
    );
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "risk-gate", status: "pass" }),
    );
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
    );
    expect(result.artifacts.map((item) => item.id)).toContain("approval-evidence");
  });

  it("keeps expired high-risk approval evidence from satisfying the risk gate", () => {
    const result = createCourseCreatorPackage({
      topic: "Clinical ventilator certification",
      outputRoot: makeTempRoot(),
      researchMode: "fixture",
      publishMode: "mock_moodle_staging",
      approvalEvidence: {
        ...highRiskApprovalEvidence(),
        expiresAt: "2026-05-14T11:59:00.000Z",
      },
      now: new Date("2026-05-14T12:00:00.000Z"),
    });

    expect(result.publishReport.status).toBe("blocked");
    expect(result.nextBuildGap.id).toBe("high-risk-approval-evidence");
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "risk-gate", status: "blocked" }),
    );
  });

  it("detects missing artifacts during validation", () => {
    const result = createCourseCreatorPackage({
      topic: "Home herb gardening",
      outputRoot: makeTempRoot(),
      now: new Date("2026-05-14T12:00:00.000Z"),
    });
    const sourcePack = result.artifacts.find((item) => item.id === "source-pack");
    expect(sourcePack).toBeDefined();
    if (!sourcePack) {
      throw new Error("source-pack artifact missing from test setup");
    }
    fs.unlinkSync(sourcePack.path);

    expect(validateCourseCreatorArtifacts(result.artifacts)).toEqual({
      status: "fail",
      missing: ["source-pack"],
      checksumMismatches: [],
    });
  });

  it("normalizes punctuation-heavy topics into stable slugs", () => {
    expect(slugifyCourseTopic("  Budgeting 101: New Parents! ")).toBe("budgeting-101-new-parents");
  });
});
