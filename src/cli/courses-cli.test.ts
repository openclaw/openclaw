import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCoursesCli } from "./courses-cli.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-courses-cli-"));
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
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return packPath;
}

function writeLiveMoodleStagingReport(root: string): string {
  const reportPath = path.join(root, "live-moodle-staging-report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "pass",
        checkedAt: "2026-05-14T12:00:00.000Z",
        courseId: "moodle-course-4242",
        courseUrl: "https://moodle.example.test/course/view.php?id=4242",
        events: [
          {
            action: "create_hidden_course",
            status: "pass",
            evidence: "Created hidden Moodle course.",
          },
          {
            action: "upload_lessons",
            status: "pass",
            evidence: "Uploaded generated lesson artifacts.",
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
          ],
        },
        recovery: {
          status: "pass",
          exportPath: "moodle-backup://course-4242/backup.mbz",
          rollbackEvidence: "Rollback proof kept course hidden.",
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
            message: "Student smoke passed.",
          },
          {
            id: "rollback-export",
            status: "present",
            source: "moodle",
            message: "Rollback proof exists.",
          },
        ],
        requiredHumanActions: [
          "Attach public publish canary approval evidence before any visibility change.",
        ],
        reason: "Live Moodle hidden staging certification passed.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return reportPath;
}

function writeApprovalEvidence(root: string): string {
  const approvalPath = path.join(root, "approval-evidence.json");
  fs.writeFileSync(
    approvalPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: "high_risk_course_review",
        decision: "approved",
        topic: "Clinical ventilator certification",
        reviewerName: "Example Clinical Reviewer",
        reviewerRole: "Credentialed subject-matter reviewer",
        approvedAt: "2026-05-14T11:00:00.000Z",
        expiresAt: "2026-06-14T11:00:00.000Z",
        evidence: "Reviewed source-backed draft for gated staging only.",
        limitations: ["Does not authorize public publish."],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return approvalPath;
}

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
}

function buildProgram(runtime: ReturnType<typeof makeRuntime>) {
  const program = new Command();
  program.exitOverride();
  registerCoursesCli(program, runtime);
  return program;
}

describe("registerCoursesCli", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("prints JSON for a topic-only course package", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      ["courses", "create", "Beginner", "sourdough", "--output-root", outputRoot, "--json"],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      status?: string;
      riskTier?: string;
      nextBuildGap?: { id?: string };
      artifacts?: Array<{ id: string; path: string }>;
    };
    expect(payload.status).toBe("blocked");
    expect(payload.riskTier).toBe("low");
    expect(payload.nextBuildGap?.id).toBe("research-source-snapshots");
    expect(
      payload.artifacts?.some((item) => item.id === "course-yaml" && fs.existsSync(item.path)),
    ).toBe(true);
  });

  it("prints fixture research source snapshots in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--fixture-research",
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      researchMode?: string;
      sources?: Array<{ snapshotPath?: string }>;
      claims?: Array<{ status?: string; sourceIds?: string[] }>;
      qaReport?: { status?: string; score?: number };
      gates?: Array<{ id?: string; status?: string }>;
      nextBuildGap?: { id?: string };
    };
    expect(payload.researchMode).toBe("fixture");
    expect(payload.sources).toHaveLength(3);
    expect(payload.claims).toHaveLength(3);
    expect(payload.sources?.every((source) => fs.existsSync(source.snapshotPath ?? ""))).toBe(true);
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "source-gate", status: "pass" }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "fact-gate", status: "pass" }),
    );
    expect(payload.qaReport).toEqual(expect.objectContaining({ status: "pass" }));
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "qa-gate", status: "pass" }),
    );
    expect(payload.nextBuildGap?.id).toBe("staging-publish-adapter");
  });

  it("prints mocked Moodle staging evidence in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--fixture-research",
        "--mock-moodle-staging",
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      publishMode?: string;
      publishReport?: {
        status?: string;
        visibility?: string;
        publicPublishAllowed?: boolean;
        evidencePath?: string | null;
        smokeTest?: { status?: string };
        recovery?: { status?: string };
      };
      gates?: Array<{ id?: string; status?: string }>;
      nextBuildGap?: { id?: string };
    };
    expect(payload.publishMode).toBe("mock_moodle_staging");
    expect(payload.publishReport).toEqual(
      expect.objectContaining({
        status: "pass",
        visibility: "hidden",
        publicPublishAllowed: false,
      }),
    );
    expect(payload.publishReport?.smokeTest).toEqual(expect.objectContaining({ status: "pass" }));
    expect(payload.publishReport?.recovery).toEqual(expect.objectContaining({ status: "pass" }));
    expect(fs.existsSync(payload.publishReport?.evidencePath ?? "")).toBe(true);
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "publish-gate", status: "pass" }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
    );
    expect(payload.nextBuildGap?.id).toBe("live-research-adapter");
  });

  it("prints mocked search/crawl staging evidence in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--mock-search-crawl",
        "--mock-moodle-staging",
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      researchMode?: string;
      sources?: Array<{ snapshotPath?: string; url?: string; credibilityScore?: number }>;
      publishReport?: { status?: string; blockers?: string[]; publicPublishAllowed?: boolean };
      gates?: Array<{ id?: string; status?: string }>;
      nextBuildGap?: { id?: string };
    };
    expect(payload.researchMode).toBe("mock_search_crawl");
    expect(payload.sources).toHaveLength(3);
    expect(payload.sources?.[0]?.url).toBe(
      "mock-search://course-creator/home-herb-gardening/institutional-guide",
    );
    expect(
      payload.sources?.every(
        (source) =>
          (source.credibilityScore ?? 0) >= 85 && fs.existsSync(source.snapshotPath ?? ""),
      ),
    ).toBe(true);
    expect(payload.publishReport).toEqual(
      expect.objectContaining({
        status: "pass",
        publicPublishAllowed: false,
      }),
    );
    expect(payload.publishReport?.blockers).toContain("live-search-provider-adapter");
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "publish-gate", status: "pass" }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
    );
    expect(payload.nextBuildGap?.id).toBe("live-search-provider-adapter");
  });

  it("prints blocked live search setup evidence in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--live-search-crawl",
        "--live-search-provider",
        "missing-provider",
        "--live-page-crawl",
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      researchMode?: string;
      sources?: unknown[];
      liveSearchReport?: { status?: string; provider?: string | null; error?: string };
      liveCrawlReport?: { status?: string; failures?: Array<{ error?: string }> };
      gates?: Array<{ id?: string; status?: string }>;
      requiredHumanActions?: string[];
      nextBuildGap?: { id?: string };
    };
    expect(payload.researchMode).toBe("live_search");
    expect(payload.sources).toEqual([]);
    expect(payload.liveSearchReport).toEqual(
      expect.objectContaining({
        status: "blocked",
        provider: "missing-provider",
      }),
    );
    expect(payload.liveSearchReport?.error).toContain("missing-provider");
    expect(payload.liveCrawlReport).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(payload.liveCrawlReport?.failures?.[0]?.error).toBe(
      "Live page crawl requires accepted live search sources first.",
    );
    expect(payload.requiredHumanActions).toContain(
      "Configure a working web_search provider and rerun live source discovery.",
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "source-gate", status: "blocked" }),
    );
    expect(payload.nextBuildGap?.id).toBe("live-search-provider-configuration");
  });

  it("prints research-pack source snapshots in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const researchPack = writeResearchPack(outputRoot);
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--research-pack",
        researchPack,
        "--mock-moodle-staging",
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      researchMode?: string;
      sources?: Array<{ snapshotPath?: string; credibilityScore?: number }>;
      gates?: Array<{ id?: string; status?: string }>;
      nextBuildGap?: { id?: string };
    };
    expect(payload.researchMode).toBe("research_pack");
    expect(payload.sources).toHaveLength(2);
    expect(
      payload.sources?.every(
        (source) =>
          (source.credibilityScore ?? 0) >= 85 && fs.existsSync(source.snapshotPath ?? ""),
      ),
    ).toBe(true);
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "publish-gate", status: "pass" }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
    );
    expect(payload.nextBuildGap?.id).toBe("automated-search-crawl-adapter");
  });

  it("prints live Moodle staging certification evidence in JSON mode", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const researchPack = writeResearchPack(outputRoot);
    const liveMoodleReport = writeLiveMoodleStagingReport(outputRoot);
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Home",
        "herb",
        "gardening",
        "--output-root",
        outputRoot,
        "--research-pack",
        researchPack,
        "--live-moodle-staging-report",
        liveMoodleReport,
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      publishMode?: string;
      publishReport?: {
        status?: string;
        adapter?: string;
        visibility?: string;
        publicPublishAllowed?: boolean;
      };
      gates?: Array<{ id?: string; status?: string; reason?: string }>;
      artifacts?: Array<{ id?: string; path?: string }>;
      requiredHumanActions?: string[];
      nextBuildGap?: { id?: string };
    };
    expect(payload.publishMode).toBe("live_moodle_staging");
    expect(payload.publishReport).toEqual(
      expect.objectContaining({
        status: "pass",
        adapter: "live",
        visibility: "hidden",
        publicPublishAllowed: false,
      }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({
        id: "publish-gate",
        status: "pass",
        reason: expect.stringContaining("Live Moodle staging"),
      }),
    );
    expect(payload.nextBuildGap?.id).toBe("public-publish-canary-approval");
    expect(payload.requiredHumanActions).toContain(
      "Attach public publish canary approval evidence before any visibility change.",
    );
    const liveReportArtifact = payload.artifacts?.find(
      (item) => item.id === "live-moodle-staging-report",
    );
    expect(fs.existsSync(liveReportArtifact?.path ?? "")).toBe(true);
  });

  it("prints high-risk approval evidence in JSON mode while keeping public publish blocked", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const approvalEvidence = writeApprovalEvidence(outputRoot);
    const program = buildProgram(runtime);

    await program.parseAsync(
      [
        "courses",
        "create",
        "Clinical",
        "ventilator",
        "certification",
        "--output-root",
        outputRoot,
        "--fixture-research",
        "--mock-moodle-staging",
        "--approval-evidence",
        approvalEvidence,
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0] as {
      status?: string;
      publishReport?: { status?: string; publicPublishAllowed?: boolean };
      gates?: Array<{ id?: string; status?: string }>;
      artifacts?: Array<{ id?: string; path?: string }>;
      approvalEvidence?: { decision?: string };
    };
    expect(payload.status).toBe("draft_only");
    expect(payload.approvalEvidence).toEqual(expect.objectContaining({ decision: "approved" }));
    expect(payload.publishReport).toEqual(
      expect.objectContaining({ status: "pass", publicPublishAllowed: false }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "risk-gate", status: "pass" }),
    );
    expect(payload.gates).toContainEqual(
      expect.objectContaining({ id: "public-publish-gate", status: "blocked" }),
    );
    const approvalArtifact = payload.artifacts?.find((item) => item.id === "approval-evidence");
    expect(fs.existsSync(approvalArtifact?.path ?? "")).toBe(true);
  });

  it("prints a text summary with the next build gap", async () => {
    const runtime = makeRuntime();
    const outputRoot = makeTempRoot();
    const program = buildProgram(runtime);

    await program.parseAsync(
      ["courses", "create", "Tax", "planning", "--output-root", outputRoot],
      { from: "user" },
    );

    const lines = runtime.log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("Status:"))).toBe(true);
    expect(
      lines.some((line) => line.includes("Next build gap: Add high-risk approval evidence")),
    ).toBe(true);
  });
});
