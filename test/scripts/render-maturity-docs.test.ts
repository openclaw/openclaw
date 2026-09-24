import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Maturity docs renderer tests cover evidence-backed generated-doc checks.
import fs from "node:fs";
import path from "node:path";
import { Parser } from "htmlparser2";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildQaOccurrenceEvidenceSummary,
  createQaEvidenceInvocation,
  validateQaEvidenceSummaryJson,
  type QaEvidenceOccurrence,
} from "../../extensions/qa-lab/api.js";
import {
  qaMaturityTaxonomyIdentity,
  qaProfileEvidencePlan,
  readQaMaturityTaxonomySource,
} from "../../extensions/qa-lab/test-api.js";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(__dirname, "../..");
const tempDirs = createTempDirTracker();

type TaxonomyFixture = {
  surfaces?: TaxonomySurfaceFixture[];
};

type TaxonomySurfaceFixture = {
  id?: string;
  archived?: boolean;
  categories?: TaxonomyCategoryFixture[];
};

type TaxonomyCategoryFixture = {
  id?: string;
  name?: string;
  features?: TaxonomyFeatureFixture[];
};

type TaxonomyFeatureFixture = {
  coverageIds?: string[];
};

type MaturityScoresFixture = {
  rollups?: {
    surface_average?: {
      quality?: { score?: number };
      completeness?: { score?: number };
    };
  };
};

afterEach(() => {
  tempDirs.cleanup();
});

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/qa/render-maturity-docs.ts", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function createMaturityInvocation(count: number) {
  return createQaEvidenceInvocation({
    scenarios: Array.from({ length: count }, () => ({
      id: "same-label",
      execution: { kind: "script" },
    })),
    channel: null,
    launch: {
      source: { ref: null, integrity: null },
      runtime: { id: null, version: null },
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    },
  });
}

function writeQaEvidence(params: {
  dir: string;
  entries: Array<{ id: string; status: "pass" | "fail" | "blocked" | "skipped" }>;
  scorecard?: unknown;
  historical?: boolean;
  taxonomyPath?: string;
  profile?: string;
  generatedAt?: string;
}) {
  const scorecard = params.scorecard ?? {
    filters: { surface: null, category: null },
    run: { evidenceEntryCount: params.entries.length },
    categories: {
      total: 0,
      fulfilled: 0,
      partial: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    features: {
      total: 0,
      fulfilled: 0,
      partial: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    coverageIds: {
      total: 0,
      fulfilled: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    categoryReports: [],
  };
  fs.mkdirSync(params.dir, { recursive: true });
  fs.writeFileSync(
    path.join(params.dir, "qa-evidence.json"),
    `${JSON.stringify(
      {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: params.generatedAt ?? "2026-06-23T00:00:00.000Z",
        evidenceMode: "full",
        profile: params.profile ?? "all",
        profilePlan: params.historical
          ? undefined
          : qaProfileEvidencePlan.build({
              profile: params.profile ?? "all",
              taxonomyIdentity: qaMaturityTaxonomyIdentity(
                readQaMaturityTaxonomySource(
                  params.taxonomyPath ?? path.join(repoRoot, "taxonomy.yaml"),
                ),
              ),
              membershipScenarios: [],
              selectedScenarios: [],
              excludedScenarios: [],
              expectedCells: [],
              observedCells: [],
            }),
        entries: params.entries.map((entry) => ({
          test: {
            kind: "qa-scenario",
            id: entry.id,
            title: entry.id,
            source: { path: `qa/scenarios/${entry.id}.yaml` },
          },
          coverage: [{ id: "tools.evidence", role: "primary" }],
          result: { status: entry.status },
        })),
        scorecard,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function allProfileScorecardFixture(
  evidenceEntryCount = 1,
  taxonomyPath = path.join(repoRoot, "taxonomy.yaml"),
) {
  const taxonomy = parseYaml(fs.readFileSync(taxonomyPath, "utf8")) as TaxonomyFixture;
  const activeSurfaces = (taxonomy.surfaces ?? []).filter((surface) => !surface.archived);
  const categoryReports = activeSurfaces.flatMap((surface) =>
    (surface.categories ?? []).map((category) => {
      const coverageIds = [
        ...new Set((category.features ?? []).flatMap((feature) => feature.coverageIds ?? [])),
      ].toSorted();
      const features = category.features ?? [];
      return {
        id: `${surface.id}.${category.id}`,
        surfaceId: surface.id,
        name: category.name,
        status: "missing",
        features: {
          total: features.length,
          fulfilled: 0,
          partial: 0,
          missing: features.length,
          fulfillmentPercent: 0,
        },
        coverageIds: {
          total: coverageIds.length,
          fulfilled: 0,
          missing: coverageIds.length,
          fulfillmentPercent: 0,
          secondaryOnly: 0,
        },
        missingCoverageIds: coverageIds,
      };
    }),
  );
  const featureCount = categoryReports.reduce((count, report) => count + report.features.total, 0);
  const coverageIdCount = categoryReports.reduce(
    (count, report) => count + report.coverageIds.total,
    0,
  );
  return {
    filters: { surface: null, category: null },
    run: { evidenceEntryCount },
    categories: {
      total: categoryReports.length,
      fulfilled: 0,
      partial: 0,
      missing: categoryReports.length,
      fulfillmentPercent: 0,
    },
    features: {
      total: featureCount,
      fulfilled: 0,
      partial: 0,
      missing: featureCount,
      fulfillmentPercent: 0,
    },
    coverageIds: {
      total: coverageIdCount,
      fulfilled: 0,
      missing: coverageIdCount,
      fulfillmentPercent: 0,
    },
    categoryReports,
  };
}

function expectedMaturityScorePercent(): number {
  const scores = parseYaml(
    fs.readFileSync(path.join(repoRoot, "qa/maturity-scores.yaml"), "utf8"),
  ) as MaturityScoresFixture;
  const quality = scores.rollups?.surface_average?.quality?.score;
  const completeness = scores.rollups?.surface_average?.completeness?.score;
  if (
    typeof quality !== "number" ||
    !Number.isFinite(quality) ||
    typeof completeness !== "number" ||
    !Number.isFinite(completeness)
  ) {
    throw new Error("maturity score fixture is missing surface rollup scores");
  }
  return Math.round((quality + completeness) / 2);
}

describe("maturity docs renderer CLI", () => {
  it.each(["full", "slim"] as const)(
    "accounts for unresolved root instances separately from %s evidence rows",
    (evidenceMode) => {
      const evidenceDir = tempDirs.make("openclaw-maturity-unresolved-");
      const outputDir = tempDirs.make("openclaw-maturity-unresolved-docs-");
      writeQaEvidence({
        dir: evidenceDir,
        entries: [{ id: "same-label", status: "pass" }],
        scorecard: allProfileScorecardFixture(),
      });
      const evidencePath = path.join(evidenceDir, "qa-evidence.json");
      const legacy = validateQaEvidenceSummaryJson(
        JSON.parse(fs.readFileSync(evidencePath, "utf8")),
      );
      const invocation = createMaturityInvocation(6);
      const passing = invocation.begin(0);
      invocation.complete(passing, { status: "pass", entries: legacy.entries });
      invocation.select(0, passing);
      // The second instance never starts; each remaining selected attempt is rowless.
      for (const [index, status] of (["pass", "fail", "blocked", "skipped"] as const).entries()) {
        const observation = invocation.begin(index + 2);
        invocation.complete(observation, { status, entries: [] });
        invocation.select(index + 2, observation);
      }
      const evidence = validateQaEvidenceSummaryJson({
        ...invocation.snapshot({ generatedAt: legacy.generatedAt, profile: "all", evidenceMode }),
        profilePlan: legacy.profilePlan,
        scorecard: legacy.scorecard,
      });
      const raw = JSON.stringify(evidence);
      fs.writeFileSync(evidencePath, raw);
      const staticAssetsDir = path.join(outputDir, "assets");
      fs.mkdirSync(staticAssetsDir);
      fs.writeFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "preserved\n");
      const args = [
        "--output-dir",
        outputDir,
        "--evidence-dir",
        evidenceDir,
        "--static-assets-dir",
        staticAssetsDir,
      ];
      const rejected = runCli(...args);
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain("5 unresolved scheduled instances");
      expect(rejected.stderr.match(/same-label \(unresolved\)/g)).toHaveLength(5);
      expect(fs.existsSync(path.join(outputDir, "maturity"))).toBe(false);
      expect(fs.readFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "utf8")).toBe(
        "preserved\n",
      );
      expect(fs.readFileSync(evidencePath, "utf8")).toBe(raw);

      const allowed = runCli(...args, "--allow-failures");
      expect(allowed.status, allowed.stderr).toBe(0);
      const scorecard = fs.readFileSync(path.join(outputDir, "maturity/scorecard.md"), "utf8");
      expect(scorecard).toContain("<span>1 checks - 1 passed</span>");
      expect(scorecard).toContain("<span>5 unresolved scheduled instances</span>");
      expect(fs.readFileSync(evidencePath, "utf8")).toBe(raw);
    },
  );

  it.each(["pass", "fail", "blocked", "ownerless"] as const)(
    "excludes contained unresolved instances while preserving %s row accounting",
    (status) => {
      const evidenceDir = tempDirs.make("openclaw-maturity-contained-");
      const outputDir = tempDirs.make("openclaw-maturity-contained-docs-");
      writeQaEvidence({
        dir: evidenceDir,
        entries: [{ id: "same-label", status: "pass" }],
        scorecard: allProfileScorecardFixture(),
      });
      const evidencePath = path.join(evidenceDir, "qa-evidence.json");
      const legacy = validateQaEvidenceSummaryJson(
        JSON.parse(fs.readFileSync(evidencePath, "utf8")),
      );
      const child = createMaturityInvocation(2);
      const childStatus = status === "ownerless" ? "pass" : status;
      const childObservation = child.begin(0);
      child.complete(childObservation, {
        status: childStatus,
        entries: legacy.entries.map((entry) =>
          Object.assign({}, entry, { result: { status: childStatus } }),
        ),
      });
      child.select(0, childObservation);
      const childEvidence = child.snapshot({ generatedAt: legacy.generatedAt });
      const parent = createMaturityInvocation(1);
      const parentObservation = parent.begin(0);
      const parentAnchor = parent.anchors[0];
      if (!parentAnchor) {
        throw new Error("fixture is missing its scheduled parent");
      }
      parent.complete(parentObservation, {
        status: "pass",
        entries: legacy.entries,
        childEvidence,
        receipts: [
          {
            id: `${parentObservation}:child`,
            phase: "prepared",
            identity: parentAnchor.launch,
            artifact: {
              kind: "producer-evidence",
              path: "child.json",
              source: "maturity-renderer-fixture",
              sha256: createHash("sha256").update(JSON.stringify(childEvidence)).digest("hex"),
            },
          },
        ],
      });
      parent.select(0, parentObservation);
      const evidence = parent.snapshot({ generatedAt: legacy.generatedAt, profile: "all" });
      if (status === "ownerless") {
        evidence.occurrences.push({
          ...parentAnchor,
          id: "ownerless-diagnostic",
          parentCell: null,
          scenario: null,
          terminalStatus: "fail",
        });
        evidence.entries.push(
          ...legacy.entries.map((entry) =>
            Object.assign({}, entry, {
              test: { ...entry.test, id: "ownerless-diagnostic" },
              result: { status: "fail" as const },
              effective: true,
              binding: { occurrenceId: "ownerless-diagnostic", assertionId: null, receiptId: null },
            }),
          ),
        );
      }
      const raw = JSON.stringify(
        validateQaEvidenceSummaryJson({
          ...evidence,
          profilePlan: legacy.profilePlan,
          scorecard: legacy.scorecard,
        }),
      );
      fs.writeFileSync(evidencePath, raw);
      const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);
      expect(result.status, result.stderr).toBe(status === "pass" ? 0 : 1);
      expect(result.stderr).not.toContain("(unresolved)");
      if (status === "pass") {
        const scorecard = fs.readFileSync(path.join(outputDir, "maturity/scorecard.md"), "utf8");
        expect(scorecard).toContain("<span>2 checks - 2 passed</span>");
        expect(scorecard).not.toContain("unresolved scheduled");
      } else {
        expect(result.stderr).toContain(
          status === "ownerless" ? "ownerless-diagnostic (fail)" : `same-label (${status})`,
        );
      }
      expect(fs.readFileSync(evidencePath, "utf8")).toBe(raw);
    },
  );

  it("renders the effective retry while retaining the original failed observation", () => {
    const evidenceDir = tempDirs.make("openclaw-maturity-occurrences-");
    const outputDir = tempDirs.make("openclaw-maturity-occurrence-docs-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "same-label", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });
    const evidencePath = path.join(evidenceDir, "qa-evidence.json");
    const legacy = validateQaEvidenceSummaryJson(JSON.parse(fs.readFileSync(evidencePath, "utf8")));
    const anchor: QaEvidenceOccurrence = {
      id: "scheduled-instance",
      parentCell: { scenarioId: "same-label", executionKind: "script", channel: null },
      scenario: { kind: "instance", resultOccurrenceId: "retry" },
      retryOf: null,
      terminalStatus: null,
      assertions: null,
      launch: {
        source: { ref: null, integrity: null },
        runtime: { id: null, version: null },
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      },
      receipts: [],
    };
    const first: QaEvidenceOccurrence = {
      ...anchor,
      id: "first",
      scenario: { kind: "observation", instanceOccurrenceId: anchor.id },
      terminalStatus: "fail",
    };
    const retry: QaEvidenceOccurrence = {
      ...first,
      id: "retry",
      retryOf: first.id,
      terminalStatus: "pass",
    };
    const entry = legacy.entries[0]!;
    const evidence = buildQaOccurrenceEvidenceSummary({
      generatedAt: legacy.generatedAt,
      profile: legacy.profile,
      profilePlan: legacy.profilePlan,
      scorecard: legacy.scorecard,
      occurrences: [anchor, first, retry],
      entries: [
        {
          ...entry,
          result: { status: "fail" },
          effective: false,
          binding: { occurrenceId: first.id, assertionId: null, receiptId: null },
        },
        {
          ...entry,
          effective: true,
          binding: { occurrenceId: retry.id, assertionId: null, receiptId: null },
        },
      ],
    });
    const raw = JSON.stringify(evidence);
    fs.writeFileSync(evidencePath, raw);
    const rendered = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);
    expect(rendered.status, rendered.stderr).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity/scorecard.md"), "utf8");
    const evidenceCard = scorecard.match(
      /<div className="maturity-evidence-card">[\s\S]*?<\/div>/,
    )?.[0];
    expect(evidenceCard).toContain("<span>1 checks - 1 passed</span>");
    expect(evidenceCard).not.toContain("failed");
    expect(fs.readFileSync(evidencePath, "utf8")).toBe(raw);
  });
  it("rejects unresolved taxonomy routes and anchors while accepting published mirrors", () => {
    const fixtureDir = tempDirs.make("openclaw-maturity-docs-links-");
    const docsRoot = path.join(fixtureDir, "docs");
    const taxonomyPath = path.join(fixtureDir, "taxonomy.yaml");
    const scoresPath = path.join(fixtureDir, "scores.yaml");
    const evidenceDir = path.join(fixtureDir, "synthetic-evidence");
    const outputDir = path.join(fixtureDir, "output");
    const links = [
      ["docs/legacy-fragment.md", "[Legacy Fragment](/guide#destination-section)"],
      ["docs/legacy-page.mdx#source-section", "[Source Section](/guide#source-section)"],
      ["docs/legacy-fragment.md#source-section", "[Source Section](/guide#destination-section)"],
      ["docs/legacy-empty.md#source-section", "[Source Section](/guide)"],
      ["docs/guide.md#direct-section", "[Direct Section](/guide#direct-section)"],
      ["docs/guide.md#missing-section", null],
      ["docs/direct.mdx#direct-section", "[Direct Section](/direct#direct-section)"],
      ["docs/legacy-page.md", "[Legacy Page](/guide)"],
      ["docs/clawhub/publishing.md", "[Publishing](/clawhub/publishing)"],
      ["docs/clawhub/publishing.md#missing-section", null],
      ["docs/clawhub/skill-format.md", "[Skill Format](/clawhub/skill-format)"],
      ["docs/clawhub/security-audits.md", "[Security Audits](/clawhub/security-audits)"],
      ["docs/clawhub/index.md", "[Index](/clawhub/index)"],
      ["docs/clawhub.md", "[Clawhub](/clawhub)"],
      ["docs/clawhub/unknown.md", null],
      ["docs/unpublished.md", null],
      ["docs/unknown.md", null],
      ["docs/legacy-missing.md", null],
      ["docs/internal/private.md", null],
      ["docs/legacy-private.md", null],
      ["https://example.test/guide#external", null],
      ["docs/legacy-external.md", null],
      ["docs/legacy-chain.md", null],
    ] as const;
    fs.mkdirSync(path.join(docsRoot, "internal"), { recursive: true });
    for (const file of ["guide.md", "direct.mdx", "internal/private.md"]) {
      fs.writeFileSync(
        path.join(docsRoot, file),
        "# Fixture page\n\n## Direct section\n\n## Source section\n\n## Destination section\n",
      );
    }
    fs.writeFileSync(
      path.join(docsRoot, "docs.json"),
      JSON.stringify({
        navigation: {
          groups: [
            {
              group: "Fixture routes",
              pages: [
                "unpublished",
                "clawhub/index",
                "clawhub/publishing",
                {
                  group: "Format and trust",
                  pages: ["clawhub/skill-format", "clawhub/security-audits"],
                },
              ],
            },
          ],
        },
        redirects: [
          ["/legacy-fragment", "/guide#destination-section"],
          ["/legacy-page", "/guide"],
          ["/legacy-empty", "/guide#"],
          ["/direct", "/guide#destination-section"],
          ["/legacy-missing", "/missing#destination-section"],
          ["/legacy-private", "/internal/private#destination-section"],
          ["/legacy-external", "https://example.test/guide#external"],
          ["/legacy-chain", "/legacy-fragment"],
        ].map(([source, destination]) => ({ source, destination })),
      }),
    );
    const surface = { id: "tools", name: "Fixture tools", family: "core", level: "experimental" };
    fs.writeFileSync(
      taxonomyPath,
      stringifyYaml({
        version: 1,
        title: "Synthetic docs link fixture",
        levels: [{ id: "experimental", code: "M1", label: "Experimental" }],
        surfaces: [
          {
            ...surface,
            categories: [
              {
                id: "links",
                name: "Docs links",
                category_note: "Synthetic fixture for renderer links",
                features: [{ name: "Fixture feature", coverageIds: ["tools.evidence"] }],
                docs: links.map(([doc]) => doc),
              },
            ],
          },
        ],
      }),
    );
    const scores = {
      quality: { score: 0, label: "Experimental" },
      completeness: { score: 0, label: "Experimental" },
    };
    fs.writeFileSync(
      scoresPath,
      stringifyYaml({
        version: 1,
        process_version: 1,
        counts: { active_surfaces: 1, category_scores: 1 },
        rollups: { surface_average: scores, category_average: scores },
        surfaces: [
          {
            ...surface,
            scores,
            categories: [
              {
                name: "Docs links",
                ...scores,
                lts: { supported: false, human_override: false },
              },
            ],
            lts: { supported_categories: 0, total_categories: 1, status: "none" },
          },
        ],
      }),
    );
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "synthetic-docs-links", status: "skipped" }],
      scorecard: allProfileScorecardFixture(1, taxonomyPath),
    });

    const result = runCli(
      "--docs-root",
      docsRoot,
      "--taxonomy",
      taxonomyPath,
      "--scores",
      scoresPath,
      "--evidence-dir",
      evidenceDir,
      "--output-dir",
      path.relative(repoRoot, outputDir),
      "--strict-inputs",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("maturity taxonomy has invalid docs references");
    for (const invalidPath of [
      "docs/clawhub/unknown.md",
      "docs/clawhub/publishing.md#missing-section",
      "docs/guide.md#missing-section",
      "docs/unknown.md",
      "docs/legacy-missing.md",
      "docs/internal/private.md",
      "docs/legacy-private.md",
      "https://example.test/guide#external",
      "docs/legacy-external.md",
      "docs/legacy-chain.md",
    ]) {
      expect(result.stderr).toContain(invalidPath);
    }
    for (const publishedMirror of [
      "docs/clawhub/skill-format.md",
      "docs/clawhub/security-audits.md",
      "docs/clawhub/index.md",
    ]) {
      expect(result.stderr).not.toContain(publishedMirror);
    }
  });

  it("checks maturity inputs without requiring QA evidence artifacts", () => {
    const result = runCli("--check");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("maturity docs inputs are valid in docs");
    expect(result.stdout).toContain("evidence-backed freshness check skipped");
  });

  it("still requires QA evidence artifacts when rendering generated docs", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-test-");
    const result = runCli("--output-dir", outputDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "maturity scorecard rendering requires all or release profile qa-evidence.json",
    );
  });

  it("rejects scorecard evidence with failed or blocked entries", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "failing-scenario", status: "fail" },
        { id: "blocked-scenario", status: "blocked" },
      ],
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("maturity docs require passing QA evidence");
    expect(result.stderr).toContain("failing-scenario (fail)");
    expect(result.stderr).toContain("blocked-scenario (blocked)");
  });

  it.each(["missing", "mismatch"] as const)(
    "rejects %s historical identity before mutating strict output",
    (identityState) => {
      const outputDir = tempDirs.make("openclaw-maturity-identity-output-");
      const evidenceDir = tempDirs.make("openclaw-maturity-identity-evidence-");
      const staticAssetsDir = path.join(outputDir, "assets");
      fs.mkdirSync(staticAssetsDir);
      fs.writeFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "preserved\n");
      writeQaEvidence({
        dir: evidenceDir,
        entries: [{ id: "historical-pass", status: "pass" }],
        historical: identityState === "missing",
        scorecard: allProfileScorecardFixture(),
      });

      if (identityState === "mismatch") {
        const file = path.join(evidenceDir, "qa-evidence.json");
        const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
        evidence.profilePlan.taxonomyIdentity.sha256 = "0".repeat(64);
        fs.writeFileSync(file, JSON.stringify(evidence));
      }

      const result = runCli(
        "--output-dir",
        outputDir,
        "--evidence-dir",
        evidenceDir,
        "--static-assets-dir",
        staticAssetsDir,
        "--strict-inputs",
        "--allow-failures",
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `semantic taxonomy identity is ${identityState === "missing" ? "missing" : "mismatched"}`,
      );
      expect(fs.readFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "utf8")).toBe(
        "preserved\n",
      );
      expect(fs.existsSync(path.join(outputDir, "maturity"))).toBe(false);
    },
  );

  it("keeps historical outcomes but leaves current coverage unscored", () => {
    const outputDir = tempDirs.make("openclaw-maturity-identity-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-identity-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "historical-pass", status: "pass" }],
      historical: true,
      scorecard: allProfileScorecardFixture(),
    });

    const scoresPath = path.join(outputDir, "scores.yaml");
    const scores = parseYaml(
      fs.readFileSync(path.join(repoRoot, "qa/maturity-scores.yaml"), "utf8"),
    );
    const coverage = { score: 100, label: "Clawesome" };
    scores.rollups.surface_average.coverage = { ...coverage };
    scores.rollups.category_average.coverage = { ...coverage };
    for (const surface of scores.surfaces) {
      surface.scores.coverage = { ...coverage };
      for (const category of surface.categories) {
        category.coverage = { ...coverage };
      }
    }
    fs.writeFileSync(scoresPath, stringifyYaml(scores));
    const result = runCli(
      "--output-dir",
      outputDir,
      "--evidence-dir",
      evidenceDir,
      "--scores",
      scoresPath,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("semantic taxonomy identity is missing");
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("Coverage Unscored");
    expect(scorecard).toContain("Historical evidence: taxonomy identity unknown");
    expect(scorecard).toContain("1 passed");
    expect(scorecard).toContain(
      `<span className="maturity-summary-value">${expectedMaturityScorePercent()}%</span>`,
    );
    expect(scorecard).not.toContain("Readiness by area");
    expect(scorecard).toContain("Historical category evidence");
    const historicalCategory = allProfileScorecardFixture().categoryReports[0]!;
    expect(scorecard).toContain(historicalCategory.name);
    expect(scorecard).toContain(historicalCategory.id);
    expect(scorecard).toContain(
      `| missing | 0 of ${historicalCategory.features.total} (0%) | 0 of ${historicalCategory.coverageIds.total} (0%) |`,
    );
  });

  it("marks same-category historical evidence mismatched after capability meaning changes", () => {
    const outputDir = tempDirs.make("openclaw-maturity-identity-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-identity-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "previous-pass", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });
    const taxonomy = readQaMaturityTaxonomySource(path.join(repoRoot, "taxonomy.yaml"));
    taxonomy.surfaces
      .flatMap((surface) => surface.categories)
      .find((category) => category.features.length > 0)!.features[0]!.description =
      "A changed capability contract";
    const taxonomyPath = path.join(outputDir, "taxonomy.yaml");
    fs.writeFileSync(taxonomyPath, stringifyYaml(taxonomy));
    const result = runCli(
      "--output-dir",
      outputDir,
      "--evidence-dir",
      evidenceDir,
      "--taxonomy",
      taxonomyPath,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("semantic taxonomy identity is mismatched");
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("Coverage Unscored");
    expect(scorecard).toContain("Historical evidence: taxonomy identity mismatch");
    expect(scorecard).toContain("1 passed");
    expect(scorecard).not.toContain("Readiness by area");
    expect(scorecard).toContain("Historical category evidence");
    const historicalCategory = allProfileScorecardFixture().categoryReports[0]!;
    expect(scorecard).toContain(historicalCategory.name);
    expect(scorecard).toContain(historicalCategory.id);
    expect(scorecard).toContain(
      `| missing | 0 of ${historicalCategory.features.total} (0%) | 0 of ${historicalCategory.coverageIds.total} (0%) |`,
    );
  });

  it("selects matching release coverage before newer mismatched all evidence", () => {
    const outputDir = tempDirs.make("openclaw-maturity-identity-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-identity-evidence-");
    writeQaEvidence({
      dir: path.join(evidenceDir, "release"),
      profile: "release",
      entries: [{ id: "current-pass", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });
    writeQaEvidence({
      dir: path.join(evidenceDir, "all"),
      generatedAt: "2099-01-01T00:00:00.000Z",
      entries: [{ id: "old-pass", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });
    const file = path.join(evidenceDir, "all", "qa-evidence.json");
    const stale = JSON.parse(fs.readFileSync(file, "utf8"));
    stale.profilePlan.taxonomyIdentity.sha256 = "0".repeat(64);
    for (const category of stale.scorecard.categoryReports) {
      category.coverageIds.fulfillmentPercent = 100;
    }
    fs.writeFileSync(file, JSON.stringify(stale));
    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);
    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("Coverage Experimental - 0%");
    expect(scorecard).toContain("Historical evidence: taxonomy identity mismatch");
    expect(scorecard).toContain("Readiness by area");
  });

  it.each([
    { status: "pass", allowFailures: false, exitCode: 0 },
    { status: "fail", allowFailures: false, exitCode: 1 },
    { status: "blocked", allowFailures: false, exitCode: 1 },
    { status: "fail", allowFailures: true, exitCode: 0 },
    { status: "blocked", allowFailures: true, exitCode: 0 },
  ] as const)(
    "keeps raw $status diagnostics separate from scorecard identity (allowFailures=$allowFailures)",
    ({ status, allowFailures, exitCode }) => {
      const outputDir = tempDirs.make("openclaw-maturity-raw-output-");
      const evidenceDir = tempDirs.make("openclaw-maturity-raw-evidence-");
      writeQaEvidence({
        dir: evidenceDir,
        entries: [{ id: "current-pass", status: "pass" }],
        scorecard: allProfileScorecardFixture(),
      });
      const rawDir = path.join(evidenceDir, "native");
      writeQaEvidence({
        dir: rawDir,
        profile: "native",
        historical: true,
        entries: [{ id: `native-${status}`, status }],
      });
      const rawPath = path.join(rawDir, "qa-evidence.json");
      const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
      delete raw.scorecard;
      fs.writeFileSync(rawPath, JSON.stringify(raw));
      const staticAssetsDir = path.join(outputDir, "assets");
      fs.mkdirSync(staticAssetsDir);
      fs.writeFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "preserved\n");
      const result = runCli(
        "--output-dir",
        outputDir,
        "--evidence-dir",
        evidenceDir,
        "--static-assets-dir",
        staticAssetsDir,
        "--strict-inputs",
        ...(allowFailures ? ["--allow-failures"] : []),
      );
      expect(result.status).toBe(exitCode);
      expect(result.stderr).not.toContain("semantic taxonomy identity");
      if (exitCode === 1) {
        expect(result.stderr).toContain(`native-${status} (${status})`);
        expect(fs.existsSync(path.join(outputDir, "maturity"))).toBe(false);
        expect(fs.readFileSync(path.join(staticAssetsDir, "taxonomy.yaml"), "utf8")).toBe(
          "preserved\n",
        );
      } else {
        expect(result.stderr).toBe("");
        const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
        expect(scorecard).toContain("Coverage Experimental - 0%");
      }
    },
  );

  it("allows incomplete evidence without awarding Coverage to non-passing checks", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "failing-scenario", status: "fail" },
        { id: "blocked-scenario", status: "blocked" },
        { id: "skipped-scenario", status: "skipped" },
      ],
      scorecard: allProfileScorecardFixture(3),
    });

    const result = runCli(
      "--output-dir",
      outputDir,
      "--evidence-dir",
      evidenceDir,
      "--allow-failures",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).not.toContain("Incomplete QA evidence accepted.");
    expect(scorecard).toContain("Coverage Experimental - 0%");
    expect(scorecard).toContain("0 passed, 1 failed, 1 blocked, 1 skipped");
  });

  it("renders passing evidence with unique section jump targets", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "skipped-scenario", status: "skipped" },
      ],
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    const taxonomy = fs.readFileSync(path.join(outputDir, "maturity", "taxonomy.md"), "utf8");
    expect(scorecard).toContain("1 passed, 1 skipped");
    expect(scorecard).not.toContain("0 failed");
    expect(scorecard).not.toContain("0 blocked");
    expect(taxonomy).toMatch(
      /<div className="maturity-category-docs">\n\n {4}\[[^\n]+\]\([^)]+\)[^\n]*\n\n {4}<\/div>/,
    );
    expect(taxonomy).not.toMatch(
      /<div className="maturity-category-docs">[^\n]*\[[^\n]+\]\([^)]+\)[^\n]*<\/div>/,
    );
    const taxonomyDocument = parseDocsDocument(taxonomy);
    for (const id of ["imessage", "imessage-and-bluebubbles"]) {
      expect(
        taxonomyDocument.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
    }
    for (const id of ["control-ui", "gateway-web-app"]) {
      expect(
        taxonomyDocument.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
    }
    for (const id of ["windows-app-node", "native-windows-companion-app"]) {
      expect(
        taxonomyDocument.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
    }
    for (const [current, legacy] of [
      [
        "community-channel-cohort",
        "mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat",
      ],
      [
        "regional-channel-cohort",
        "feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels",
      ],
    ]) {
      for (const id of [current, legacy]) {
        expect(
          taxonomyDocument.ids.filter((candidate: string) => candidate === id),
          id,
        ).toHaveLength(1);
      }
    }
    expect(taxonomy).toContain(
      "**Current catalog members:** [Buzz](/channels/buzz), [ClickClack](/channels/clickclack)",
    );
    expect(taxonomy).toContain("[WeChat](/channels/wechat), [WeCom](/channels/wecom)");
    for (const id of [
      "chromeos-raspberry-pi-and-small-linux-devices",
      "raspberry-pi-and-small-linux-devices",
    ]) {
      expect(
        taxonomyDocument.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
    }
    for (const id of ["automation-and-durable-work", "automation-cron-hooks-tasks-polling"]) {
      expect(
        taxonomyDocument.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
    }
    for (const [markdown, id] of [
      [scorecard, "surface-explorer"],
      [taxonomy, "product-areas"],
    ]) {
      const document = parseDocsDocument(markdown);
      expect(document.links).toContain(`#${id}`);
      expect(
        document.ids.filter((candidate: string) => candidate === id),
        id,
      ).toHaveLength(1);
      expect(document.collisions).toEqual([]);
    }
  });

  it.each(["absent", "matching", "mismatched"] as const)(
    "renders %s decision history without changing strict validation or current judgments",
    (history) => {
      const dir = tempDirs.make("openclaw-maturity-decisions-");
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      const scoresPath = path.join(dir, "scores.yaml");
      const evidenceDir = path.join(dir, "evidence");
      const record = <T extends string | number | boolean>(value: T) => ({
        value,
        rationale:
          'Synthetic <review> {context} | "quoted" & `code` [link](https://example.test)\nsecond line',
        reviewer: "Fixture reviewer",
        evidence_refs: ["qa/fixture-one", "qa/fixture-two"],
        revalidate_when: "The reviewed behavior changes",
      });
      const reviewed = history !== "absent";
      const mismatch = history === "mismatched";
      const score = (value: number, label: string) => ({ score: value, label });
      const bundle = {
        quality: score(70, "Beta"),
        completeness: score(80, "Stable"),
      };
      const authored = {
        quality: {
          ...bundle.quality,
          ...(reviewed ? { decision: record(mismatch ? 69 : 70) } : {}),
        },
        completeness: {
          ...bundle.completeness,
          ...(reviewed ? { decision: record(mismatch ? 79 : 80) } : {}),
        },
      };
      fs.writeFileSync(
        taxonomyPath,
        stringifyYaml({
          version: 1,
          title: "Synthetic decision fixture",
          levels: [
            { id: "experimental", code: "M1", label: "Experimental" },
            { id: "stable", code: "M4", label: "Stable" },
          ],
          surfaces: [
            {
              id: "tools",
              name: "Fixture tools",
              family: "core",
              level: "experimental",
              ...(reviewed ? { level_decision: record(mismatch ? "stable" : "experimental") } : {}),
              categories: [
                {
                  id: "review",
                  name: "Review",
                  category_note: "Synthetic review",
                  features: [{ name: "Fixture feature", coverageIds: ["tools.evidence"] }],
                },
              ],
            },
          ],
        }),
      );
      fs.writeFileSync(
        scoresPath,
        stringifyYaml({
          version: 1,
          process_version: 1,
          counts: { active_surfaces: 1, category_scores: 1 },
          rollups: { surface_average: bundle, category_average: bundle },
          surfaces: [
            {
              id: "tools",
              name: "Fixture tools",
              level: "experimental",
              scores: authored,
              categories: [
                {
                  name: "Review",
                  ...authored,
                  lts: {
                    supported: false,
                    human_override: false,
                    ...(reviewed ? { decision: record(mismatch) } : {}),
                  },
                },
              ],
              lts: { supported_categories: 0, total_categories: 1, status: "none" },
            },
          ],
        }),
      );
      writeQaEvidence({
        dir: evidenceDir,
        taxonomyPath,
        entries: [{ id: "synthetic-review", status: "pass" }],
        scorecard: allProfileScorecardFixture(1, taxonomyPath),
      });
      const result = runCli(
        "--taxonomy",
        taxonomyPath,
        "--scores",
        scoresPath,
        "--evidence-dir",
        evidenceDir,
        "--output-dir",
        dir,
        "--strict-inputs",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const scorecard = fs.readFileSync(path.join(dir, "maturity/scorecard.md"), "utf8");
      const taxonomy = fs.readFileSync(path.join(dir, "maturity/taxonomy.md"), "utf8");
      for (const markdown of [scorecard, taxonomy]) {
        expect(markdown).toContain("<summary>Decision context</summary>");
        const decisionBlocks =
          markdown.match(/<details>\s*<summary>Decision context<\/summary>[\s\S]*?<\/details>/gu) ??
          [];
        expect(decisionBlocks.length).toBeGreaterThan(0);
        for (const block of decisionBlocks) {
          // Native labelled flow avoids forbidden table elements and conflicting ARIA roles.
          expect(block).not.toMatch(/<\/?(?:table|thead|tbody|tr|th|td)(?:\s|>)|\srole=/u);
          expect(block).not.toMatch(/<p>(?:(?!<\/p>)[\s\S])*<div>/u);
        }
        expect(markdown).toContain("Coverage Experimental - 0%");
        const md = createDocsMarkdown();
        const document = parseDocsDocument(markdown, md);
        expect(document.collisions).toEqual([]);
        const visibleText: string[] = [];
        const tags: string[] = [];
        const parser = new Parser({
          ontext: (value) => visibleText.push(value),
          onopentag: (name) => {
            tags.push(name);
            if (name === "br") {
              visibleText.push("\n");
            }
          },
        });
        parser.end(md.renderer.render(document.tokens, md.options, document.env));
        const textContent = visibleText.join("");
        for (const [label, value] of [
          ["Level", "experimental"],
          ["Quality", "70"],
          ["Completeness", "80"],
        ]) {
          expect(textContent).toContain(`${label}Current value: ${value}Recorded decision: `);
        }
        expect(tags).not.toContain("review");
        expect(markdown.includes("Non-gating mismatch")).toBe(mismatch);
        expect(markdown.includes("Unknown (not recorded)")).toBe(!reviewed);
        if (reviewed) {
          for (const text of [
            `Rationale: ${record(70).rationale}`,
            "Reviewer: Fixture reviewer",
            "Evidence: qa/fixture-one; qa/fixture-two",
            "Revalidate when: The reviewed behavior changes",
            `Recorded value: ${mismatch ? "stable" : "experimental"}`,
            `Recorded value: ${mismatch ? 69 : 70}`,
            `Recorded value: ${mismatch ? 79 : 80}`,
          ]) {
            expect(textContent).toContain(text);
          }
        }
      }
      expect(scorecard).toContain('<span className="maturity-summary-value">75%</span>');
      expect(taxonomy).toContain("<span>Review / LTS</span>");
      expect(taxonomy).toContain("<p>Current value: <span>false</span></p>");
      expect(taxonomy).not.toContain(" / LTS-supported");
      expect(taxonomy.match(/Non-gating mismatch/g) ?? []).toHaveLength(mismatch ? 6 : 0);
      expect(scorecard.match(/Non-gating mismatch/g) ?? []).toHaveLength(mismatch ? 3 : 0);
    },
  );

  it("renders the maturity score from quality and completeness without coverage", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "passing-scenario", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("<span>Maturity score</span>");
    expect(scorecard).toContain(
      `<span className="maturity-summary-value">${expectedMaturityScorePercent()}%</span>`,
    );
    expect(scorecard).toContain("Coverage Experimental - 0%");
    expect(scorecard).toContain("end-to-end coverage above 90%");
  });
});
