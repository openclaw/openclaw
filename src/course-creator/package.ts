import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildCourseCreatorQualityPolicyReport,
  type CourseCreatorQualityPolicyReport,
} from "./quality.js";

export type CourseCreatorRiskTier = "low" | "high";
export type CourseCreatorStatus = "blocked" | "draft_only";
export type CourseCreatorGateStatus = "pass" | "blocked";
export type CourseCreatorEvidenceStatus = CourseCreatorGateStatus | "failed";
export type CourseCreatorResearchMode =
  | "none"
  | "fixture"
  | "research_pack"
  | "mock_search_crawl"
  | "live_search";
export type CourseCreatorPublishMode = "none" | "mock_moodle_staging" | "live_moodle_staging";
export type CourseCreatorClaimStatus = "verified" | "unsupported";
export type CourseCreatorApprovalScope = "high_risk_course_review" | "public_publish_canary";
export type CourseCreatorApprovalDecision = "approved" | "rejected";

export type CourseCreatorGate = {
  id: string;
  status: CourseCreatorGateStatus;
  score: number;
  reason: string;
};

export type CourseCreatorArtifact = {
  id: string;
  path: string;
  checksum: string;
};

export type CourseCreatorNextBuildGap = {
  id: string;
  title: string;
  reason: string;
  requiredActions: string[];
};

export type CourseCreatorApprovalEvidence = {
  schemaVersion: 1;
  scope: CourseCreatorApprovalScope;
  decision: CourseCreatorApprovalDecision;
  topic: string;
  reviewerName: string;
  reviewerRole: string;
  approvedAt: string;
  expiresAt: string | null;
  evidence: string;
  limitations: string[];
};

export type CourseCreatorSourceSnapshot = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  tier: "A" | "B" | "C";
  credibilityScore: number;
  retrievedAt: string;
  license: string;
  snapshotPath: string;
  checksum: string;
};

export type CourseCreatorClaimEvidence = {
  sourceId: string;
  snapshotPath: string;
  checksum: string;
};

export type CourseCreatorClaimEvidenceSpan = {
  sourceId: string;
  excerpt: string;
};

export type CourseCreatorClaim = {
  id: string;
  lessonId: string;
  text: string;
  status: CourseCreatorClaimStatus;
  sourceIds: string[];
  evidence: CourseCreatorClaimEvidence[];
  evidenceSpans?: CourseCreatorClaimEvidenceSpan[];
  confidence: number;
  notes: string;
};

export type CourseCreatorClaimVerification = {
  status: "pass" | "fail";
  verified: number;
  unsupported: number;
  missingSourceIds: string[];
};

export type CourseCreatorResearchPackSourceInput = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  tier: "A" | "B" | "C";
  credibilityScore: number;
  license: string;
  content: string;
};

export type CourseCreatorResearchPackClaimInput = {
  id: string;
  lessonId?: string;
  text: string;
  sourceIds: string[];
  evidenceSpans?: CourseCreatorClaimEvidenceSpan[];
};

export type CourseCreatorResearchPackInput = {
  schemaVersion: 1;
  sources: CourseCreatorResearchPackSourceInput[];
  claims: CourseCreatorResearchPackClaimInput[];
};

export type CourseCreatorLiveSearchReport = {
  status: CourseCreatorGateStatus;
  provider: string | null;
  query: string;
  resultCount: number;
  sourceIds: string[];
  searchedAt: string;
  error?: string;
  requiredHumanActions: string[];
};

export type CourseCreatorLiveCrawlFailure = {
  sourceId: string;
  url: string;
  error: string;
};

export type CourseCreatorLiveCrawlReport = {
  status: CourseCreatorGateStatus;
  requested: number;
  fetched: number;
  sourceIds: string[];
  semanticClaimsExtracted: number;
  semanticClaimSourceIds: string[];
  crawledAt: string;
  failures: CourseCreatorLiveCrawlFailure[];
  requiredHumanActions: string[];
};

export type CourseCreatorQaReport = {
  status: CourseCreatorGateStatus;
  score: number;
  passThreshold: number;
  criticalFailures: string[];
  rubric: CourseCreatorQaRubricItem[];
};

export type CourseCreatorQaRubricItem = {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  status: CourseCreatorGateStatus;
  reason: string;
};

export type CourseCreatorPublishEvent = {
  action: string;
  status: CourseCreatorEvidenceStatus;
  evidence: string;
};

export type CourseCreatorPublishReport = {
  status: CourseCreatorGateStatus | "not_attempted";
  mode: CourseCreatorPublishMode;
  target: "none" | "moodle";
  adapter: "none" | "mock" | "live";
  visibility: "none" | "hidden";
  publicPublishAllowed: boolean;
  courseId: string | null;
  courseUrl: string | null;
  evidencePath: string | null;
  events: CourseCreatorPublishEvent[];
  smokeTest: {
    status: CourseCreatorGateStatus;
    checks: CourseCreatorPublishEvent[];
  };
  recovery: {
    status: CourseCreatorGateStatus;
    exportPath: string | null;
    rollbackEvidence: string | null;
  };
  blockers: string[];
  reason: string;
};

export type CourseCreatorLiveMoodleStagingChecklistItem = {
  id: string;
  status: "present" | "missing" | "failed";
  source: string;
  message: string;
};

export type CourseCreatorLiveMoodleStagingReport = {
  status: CourseCreatorGateStatus;
  checkedAt: string;
  courseId: string | null;
  courseUrl: string | null;
  events: CourseCreatorPublishEvent[];
  smokeTest: {
    status: CourseCreatorGateStatus;
    checks: CourseCreatorPublishEvent[];
  };
  recovery: {
    status: CourseCreatorGateStatus;
    exportPath: string | null;
    rollbackEvidence: string | null;
  };
  blockers: string[];
  checklist: CourseCreatorLiveMoodleStagingChecklistItem[];
  requiredHumanActions: string[];
  reason: string;
};

export type CourseCreatorContentGenerationReport = {
  status: CourseCreatorGateStatus;
  mode: "scaffold" | "multi_module_course";
  moduleCount: number;
  lessonCount: number;
  activityCount: number;
  quizQuestionCount: number;
  sourceClaimCount: number;
  evidenceSpanCount: number;
  requiredHumanActions: string[];
};

export type CourseCreatorPackageResult = {
  schemaVersion: 1;
  jobId: string;
  topic: string;
  slug: string;
  status: CourseCreatorStatus;
  riskTier: CourseCreatorRiskTier;
  researchMode: CourseCreatorResearchMode;
  publishMode: CourseCreatorPublishMode;
  outputDir: string;
  artifacts: CourseCreatorArtifact[];
  gates: CourseCreatorGate[];
  sources: CourseCreatorSourceSnapshot[];
  claims: CourseCreatorClaim[];
  qaReport: CourseCreatorQaReport;
  qualityPolicyReport: CourseCreatorQualityPolicyReport;
  publishReport: CourseCreatorPublishReport;
  contentGenerationReport: CourseCreatorContentGenerationReport;
  liveSearchReport?: CourseCreatorLiveSearchReport;
  liveCrawlReport?: CourseCreatorLiveCrawlReport;
  liveMoodleStagingReport?: CourseCreatorLiveMoodleStagingReport;
  approvalEvidence?: CourseCreatorApprovalEvidence;
  requiredHumanActions: string[];
  nextBuildGap: CourseCreatorNextBuildGap;
};

export type CreateCourseCreatorPackageOptions = {
  topic: string;
  outputRoot: string;
  researchMode?: CourseCreatorResearchMode;
  researchPackPath?: string;
  researchPackInput?: CourseCreatorResearchPackInput;
  liveSearchReport?: CourseCreatorLiveSearchReport;
  liveCrawlReport?: CourseCreatorLiveCrawlReport;
  liveMoodleStagingReport?: CourseCreatorLiveMoodleStagingReport;
  approvalEvidencePath?: string;
  approvalEvidence?: CourseCreatorApprovalEvidence;
  publishMode?: CourseCreatorPublishMode;
  now?: Date;
};

const HIGH_RISK_PATTERNS = [
  /\bclinical\b/iu,
  /\bmedical\b/iu,
  /\bdiagnos(?:e|is|tic)\b/iu,
  /\btherapy\b/iu,
  /\bsurgery\b/iu,
  /\bdrug\b/iu,
  /\blegal\b/iu,
  /\btax\b/iu,
  /\binvest(?:ing|ment)?\b/iu,
  /\bfinancial advice\b/iu,
  /\bcompliance\b/iu,
  /\bcertification\b/iu,
  /\bsafety\b/iu,
  /\bemergency\b/iu,
  /\bfirst aid\b/iu,
];

function normalizeTopic(topic: string): string {
  const normalized = topic.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new Error("Course topic is required.");
  }
  if (normalized.length > 180) {
    throw new Error("Course topic must be 180 characters or fewer.");
  }
  return normalized;
}

export function slugifyCourseTopic(topic: string): string {
  const slug = topic
    .normalize("NFKD")
    .replace(/[^\w\s-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug || "course";
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function checksum(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function classifyRisk(topic: string): CourseCreatorRiskTier {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(topic)) ? "high" : "low";
}

function createCourseYaml(params: {
  jobId: string;
  topic: string;
  slug: string;
  status: CourseCreatorStatus;
  riskTier: CourseCreatorRiskTier;
  researchMode: CourseCreatorResearchMode;
  publishMode: CourseCreatorPublishMode;
  createdAt: string;
}): string {
  return [
    "schemaVersion: 1",
    `jobId: ${params.jobId}`,
    `topic: ${JSON.stringify(params.topic)}`,
    `slug: ${params.slug}`,
    `status: ${params.status}`,
    `riskTier: ${params.riskTier}`,
    `researchMode: ${params.researchMode}`,
    `publishMode: ${params.publishMode}`,
    `createdAt: ${params.createdAt}`,
    "publishPolicy: blocked_until_source_fact_qa_publish_and_recovery_gates_pass",
    "",
  ].join("\n");
}

function buildRequiredHumanActions(
  riskTier: CourseCreatorRiskTier,
  highRiskApprovalPassed: boolean,
  researchMode: CourseCreatorResearchMode,
  publishMode: CourseCreatorPublishMode,
  liveSearchReport: CourseCreatorLiveSearchReport | undefined,
  liveCrawlReport: CourseCreatorLiveCrawlReport | undefined,
  liveMoodleStagingReport: CourseCreatorLiveMoodleStagingReport | undefined,
  contentGenerationReport: CourseCreatorContentGenerationReport | undefined,
): string[] {
  const actions =
    publishMode === "mock_moodle_staging"
      ? ["Replace mocked Moodle staging with live Moodle credentials before real courses."]
      : publishMode === "live_moodle_staging"
        ? liveMoodleStagingReport?.status === "pass"
          ? ["Attach public publish canary approval evidence before any visibility change."]
          : [
              "Keep public publish blocked until live Moodle staging certification and approval evidence pass.",
            ]
        : ["Configure a Moodle staging publish target before any public publish attempt."];
  if (researchMode === "none") {
    actions.unshift("Configure a research adapter with source snapshot support.");
  } else if (researchMode === "research_pack") {
    actions.unshift(
      "Replace per-course research pack input with automated search/crawl before topic-only production.",
    );
  } else if (researchMode === "mock_search_crawl") {
    actions.unshift("Replace mocked search/crawl with a live search provider before production.");
  } else if (researchMode === "live_search") {
    if (liveSearchReport?.status !== "pass") {
      actions.unshift("Configure a working web_search provider and rerun live source discovery.");
    } else if (
      liveCrawlReport?.status === "pass" &&
      liveCrawlReport.semanticClaimsExtracted > 0 &&
      contentGenerationReport?.status === "pass"
    ) {
      actions.unshift("Configure and certify live Moodle staging before production publishing.");
    } else if (liveCrawlReport?.status === "pass" && liveCrawlReport.semanticClaimsExtracted > 0) {
      actions.unshift(
        "Generate learner-facing lessons from semantically extracted source claims before production.",
      );
    } else if (liveCrawlReport?.status === "pass") {
      actions.unshift(
        "Replace metadata-only live crawl claims with semantic claim extraction before production.",
      );
    } else if (liveCrawlReport?.status === "blocked") {
      actions.unshift("Resolve live page crawl failures and rerun source extraction.");
    } else {
      actions.unshift(
        "Add live page crawl/content extraction before production course generation.",
      );
    }
  } else {
    actions.unshift(
      "Replace fixture research with a live search/crawl adapter before real courses.",
    );
  }
  if (publishMode === "live_moodle_staging" && liveMoodleStagingReport?.status !== "pass") {
    actions.push(
      "Provide least-privilege Moodle staging credentials and execute the live staging certification runner.",
    );
  }
  if (riskTier === "high" && !highRiskApprovalPassed) {
    actions.push("Attach explicit expert or human approval evidence before public release.");
  }
  return actions;
}

function buildGates(
  riskTier: CourseCreatorRiskTier,
  highRiskApprovalPassed: boolean,
  researchMode: CourseCreatorResearchMode,
  sourceCount: number,
  claimVerification: CourseCreatorClaimVerification,
  qaReport: CourseCreatorQaReport,
  publishReport: CourseCreatorPublishReport,
): CourseCreatorGate[] {
  const hasSourceSnapshots = sourceCount >= 2;
  const claimsVerified = claimVerification.status === "pass";
  const stagingPublishPassed = publishReport.status === "pass";
  const stagingAdapterLabel = publishReport.adapter === "live" ? "Live Moodle" : "Mock Moodle";
  const sourceGateReason =
    hasSourceSnapshots && researchMode === "fixture"
      ? "Deterministic fixture research snapshots exist with checksum metadata."
      : hasSourceSnapshots && researchMode === "research_pack"
        ? "Configured research-pack sources were snapshotted with checksum metadata."
        : hasSourceSnapshots && researchMode === "mock_search_crawl"
          ? "Mock search/crawl sources were snapshotted with checksum metadata."
          : hasSourceSnapshots && researchMode === "live_search"
            ? "Live web_search provider results were snapshotted with checksum metadata."
            : researchMode === "live_search"
              ? "Live web_search did not return enough accepted source snapshots."
              : "No configured research adapter has snapshotted credible sources yet.";
  return [
    {
      id: "topic-intake",
      status: "pass",
      score: 100,
      reason: "Topic-only input was accepted and normalized.",
    },
    {
      id: "source-gate",
      status: hasSourceSnapshots ? "pass" : "blocked",
      score: hasSourceSnapshots ? 90 : 0,
      reason: sourceGateReason,
    },
    {
      id: "fact-gate",
      status: claimsVerified ? "pass" : "blocked",
      score: claimsVerified ? 95 : 0,
      reason: claimsVerified
        ? "All claims are mapped to accepted source snapshot evidence."
        : hasSourceSnapshots
          ? "Claim extraction or source-to-claim verification has not passed yet."
          : "Fact checking cannot pass before source-backed claims exist.",
    },
    {
      id: "qa-gate",
      status: qaReport.status,
      score: qaReport.score,
      reason:
        qaReport.status === "pass"
          ? "Source-backed package QA passed the deterministic rubric threshold."
          : "QA cannot pass until source-backed claims and rubric checks pass.",
    },
    {
      id: "publish-gate",
      status: stagingPublishPassed ? "pass" : "blocked",
      score: stagingPublishPassed ? 100 : 0,
      reason: stagingPublishPassed
        ? `${stagingAdapterLabel} staging produced hidden-course publish evidence.`
        : "No staging LMS certification or rollback evidence exists yet.",
    },
    {
      id: "smoke-gate",
      status: publishReport.smokeTest.status,
      score: publishReport.smokeTest.status === "pass" ? 100 : 0,
      reason:
        publishReport.smokeTest.status === "pass"
          ? `Student-view smoke checks passed against the ${publishReport.adapter} staging course.`
          : "Student-view smoke checks have not passed yet.",
    },
    {
      id: "recovery-gate",
      status: publishReport.recovery.status,
      score: publishReport.recovery.status === "pass" ? 100 : 0,
      reason:
        publishReport.recovery.status === "pass"
          ? `${stagingAdapterLabel} export and rollback evidence exists.`
          : "Recovery export and rollback evidence has not passed yet.",
    },
    {
      id: "public-publish-gate",
      status: "blocked",
      score: 0,
      reason:
        publishReport.adapter === "live" && publishReport.status === "pass"
          ? "Live hidden-course staging proof is not public publish permission; canary approval is still required."
          : publishReport.status === "pass"
            ? "Mock staging proof is not live public publish permission."
            : "Public publish is blocked until all earlier gates pass on a live target.",
    },
    {
      id: "risk-gate",
      status: riskTier === "high" && !highRiskApprovalPassed ? "blocked" : "pass",
      score: riskTier === "high" && !highRiskApprovalPassed ? 0 : 100,
      reason:
        riskTier === "high" && !highRiskApprovalPassed
          ? "High-risk topics require human or expert approval before public release."
          : riskTier === "high"
            ? "High-risk approval evidence was accepted for gated draft and staging work."
            : "No high-risk topic keywords were detected.",
    },
  ];
}

function buildNextBuildGap(
  riskTier: CourseCreatorRiskTier,
  highRiskApprovalPassed: boolean,
  researchMode: CourseCreatorResearchMode,
  publishMode: CourseCreatorPublishMode,
  claimVerification: CourseCreatorClaimVerification,
  qaReport: CourseCreatorQaReport,
  publishReport: CourseCreatorPublishReport,
  liveCrawlReport: CourseCreatorLiveCrawlReport | undefined,
  contentGenerationReport: CourseCreatorContentGenerationReport | undefined,
): CourseCreatorNextBuildGap {
  if (riskTier === "high" && !highRiskApprovalPassed) {
    return {
      id: "high-risk-approval-evidence",
      title: "Add high-risk approval evidence before public publish",
      reason:
        "The topic is regulated or safety-sensitive, so automated public publish must fail closed.",
      requiredActions: [
        "Define the expert approval evidence schema.",
        "Store approval evidence beside the course package.",
        "Require the approval gate before public publish.",
      ],
    };
  }
  if (
    publishMode === "live_moodle_staging" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass" &&
    publishReport.status === "pass"
  ) {
    return {
      id: "public-publish-canary-approval",
      title: "Add public publish canary approval and rollback policy",
      reason:
        "Live hidden Moodle staging passed, but the public publish gate remains intentionally closed until canary approval, rollback, and permission policy are explicit.",
      requiredActions: [
        "Define public publish approval evidence and canary scope.",
        "Require a dedicated non-admin test learner and rollback proof before visibility changes.",
        "Persist public publish events separately from staging certification.",
      ],
    };
  }
  if (
    publishMode === "live_moodle_staging" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass"
  ) {
    return {
      id: "live-moodle-staging-certification",
      title: "Certify live Moodle staging publish and rollback",
      reason:
        "Source, fact, and QA gates pass, but the live Moodle staging runner has not produced hidden-course, smoke-test, and recovery evidence.",
      requiredActions: [
        "Configure Moodle staging URL, token, category id, and explicit live allow flag.",
        "Run the live Moodle staging runner against a least-privilege automation account.",
        "Record hidden-course publish, student-preview smoke, export, and rollback evidence.",
      ],
    };
  }
  if (
    researchMode === "live_search" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass" &&
    publishReport.status === "pass"
  ) {
    if (
      liveCrawlReport?.status === "pass" &&
      liveCrawlReport.semanticClaimsExtracted > 0 &&
      contentGenerationReport?.status === "pass"
    ) {
      return {
        id: "live-moodle-staging-certification",
        title: "Certify live Moodle staging publish and rollback",
        reason:
          "The semantic claim map now expands into a multi-module course package, but the publishing proof is still mocked rather than certified against a live Moodle staging site.",
        requiredActions: [
          "Configure a least-privilege Moodle automation account and staging URL.",
          "Create a hidden staging course with modules, lessons, quizzes, and completion rules.",
          "Run student-preview smoke tests plus export and rollback proof on the live staging site.",
        ],
      };
    }
    if (liveCrawlReport?.status === "pass" && liveCrawlReport.semanticClaimsExtracted > 0) {
      return {
        id: "learner-facing-lesson-generation-from-semantic-claims",
        title: "Generate learner-facing lessons from semantic source claims",
        reason:
          "Live search, guarded page extraction, and semantic claim extraction now pass, but the lesson artifact is still a scaffold rather than complete course instruction.",
        requiredActions: [
          "Generate module and lesson bodies from the semantic claim map.",
          "Create practice activities and quiz explanations that cite claim evidence spans.",
          "Run QA against the generated learner-facing content instead of the scaffold lesson.",
        ],
      };
    }
    if (liveCrawlReport?.status === "pass") {
      return {
        id: "semantic-claim-extraction-from-crawled-sources",
        title: "Extract factual course claims from crawled source text",
        reason:
          "Live search and guarded page extraction now pass, but generated claims still need semantic extraction from the crawled source text.",
        requiredActions: [
          "Extract atomic factual claims from crawled page content.",
          "Map each claim to source ids and evidence spans.",
          "Generate learner-facing lessons from supported claims instead of adapter metadata.",
        ],
      };
    }
    return {
      id: "live-page-crawl-content-extraction",
      title: "Fetch live pages and extract course-grounding content",
      reason:
        "Live search can now produce source candidates, but course-quality generation still needs full page extraction instead of search snippets.",
      requiredActions: [
        "Fetch accepted result URLs through the guarded web_fetch/runtime crawler path.",
        "Snapshot extracted page text, content type, retrieval status, and checksum metadata.",
        "Generate factual lesson claims from extracted page content, not only search-result snippets.",
      ],
    };
  }
  if (
    researchMode === "mock_search_crawl" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass" &&
    publishReport.status === "pass"
  ) {
    return {
      id: "live-search-provider-adapter",
      title: "Connect a live search provider and crawler",
      reason:
        "Topic-only mock search/crawl now passes all local gates, but it does not fetch live web sources.",
      requiredActions: [
        "Wire a Brave Search, OpenClaw web search, or equivalent search provider adapter.",
        "Crawl accepted URLs and snapshot retrieval metadata with checksums.",
        "Replay source, fact, QA, staging, smoke, and recovery gates with live source packs.",
      ],
    };
  }
  if (
    researchMode === "research_pack" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass" &&
    publishReport.status === "pass"
  ) {
    return {
      id: "automated-search-crawl-adapter",
      title: "Automate search and crawl source discovery",
      reason:
        "Configured source packs now replay through all local gates, but course creation is not topic-only until source discovery runs automatically.",
      requiredActions: [
        "Add a search provider adapter with bounded query budgets.",
        "Crawl and snapshot accepted URLs without per-course research-pack input.",
        "Keep the research-pack adapter as a replay fixture for regression tests.",
      ],
    };
  }
  if (
    researchMode === "fixture" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass" &&
    publishReport.status === "pass"
  ) {
    return {
      id: "live-research-adapter",
      title: "Replace fixture research with live source snapshots",
      reason:
        "The mocked Moodle staging contract now passes, but fixture sources are not live factual authority for real courses.",
      requiredActions: [
        "Implement a search/crawl adapter that snapshots real accepted sources.",
        "Score source credibility and preserve retrieval metadata.",
        "Replay the source, fact, QA, staging, smoke, and recovery gates with live source packs.",
      ],
    };
  }
  if (
    researchMode !== "none" &&
    claimVerification.status === "pass" &&
    qaReport.status === "pass"
  ) {
    return {
      id: "staging-publish-adapter",
      title: "Add Moodle staging publish and smoke tests",
      reason:
        "Source, fact, and QA gates now pass, but no Moodle staging publish, smoke test, or rollback evidence exists.",
      requiredActions: [
        "Implement a Moodle adapter that creates hidden staging courses by default.",
        "Run student-view smoke tests against the staged course.",
        "Record rollback/export evidence before any public publish path can pass.",
      ],
    };
  }
  if (researchMode !== "none" && claimVerification.status === "pass") {
    return {
      id: "qa-rubric-validation",
      title: "Add automated QA rubric validation",
      reason:
        "Source and fact gates pass, but QA still needs concrete validators before publish can be attempted.",
      requiredActions: [
        "Score curriculum progression, lesson clarity, assessment quality, accessibility, and originality.",
        "Fail closed on critical QA issues such as broken answer keys or unsupported claims.",
        "Write qa-report.json with pass/fail evidence and threshold scores.",
      ],
    };
  }
  if (researchMode !== "none") {
    if (researchMode === "live_search") {
      return {
        id: "live-search-provider-configuration",
        title: "Configure a working live web_search provider",
        reason:
          "The live search adapter exists, but no accepted source snapshots were produced in this run.",
        requiredActions: [
          "Configure a web_search provider such as Brave, DuckDuckGo, SearXNG, or another supported provider.",
          "Verify network access and credentials outside the Course Creator prompt.",
          "Rerun live source discovery until at least two credible source snapshots are accepted.",
        ],
      };
    }
    return {
      id: "claim-map-fact-checking",
      title: "Extract and verify source-backed claims",
      reason:
        "Source snapshots now exist, but lessons still cannot pass until claims map to source evidence.",
      requiredActions: [
        "Extract atomic claims from lesson drafts.",
        "Attach each factual claim to one or more accepted source ids.",
        "Reject unsupported or contradictory claims before QA.",
      ],
    };
  }
  return {
    id: "research-source-snapshots",
    title: "Connect research source snapshots",
    reason:
      "The artifact package exists, but source, fact, QA, and publish gates cannot pass without real sources.",
    requiredActions: [
      "Add a research adapter contract.",
      "Snapshot each accepted source with checksum metadata.",
      "Map lesson claims to source ids before QA.",
    ],
  };
}

function qaItem(params: {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  reason: string;
}): CourseCreatorQaRubricItem {
  return {
    ...params,
    status: params.score === params.maxScore || params.score > 0 ? "pass" : "blocked",
  };
}

function buildQaReport(params: {
  researchMode: CourseCreatorResearchMode;
  claimVerification: CourseCreatorClaimVerification;
  claims: readonly CourseCreatorClaim[];
  sources: readonly CourseCreatorSourceSnapshot[];
  qualityPolicyReport: CourseCreatorQualityPolicyReport;
  contentGenerationReport?: CourseCreatorContentGenerationReport;
}): CourseCreatorQaReport {
  const passThreshold = 90;
  if (
    params.researchMode === "none" ||
    params.claimVerification.status !== "pass" ||
    params.claims.length === 0 ||
    params.sources.length === 0
  ) {
    return {
      status: "blocked",
      score: 0,
      passThreshold,
      criticalFailures: ["missing-source-backed-claim-evidence"],
      rubric: [
        {
          id: "source-quality-citation-coverage",
          label: "Source quality and citation coverage",
          score: 0,
          maxScore: 15,
          status: "blocked",
          reason: "No accepted source-backed claim set is available for QA.",
        },
        {
          id: "factual-accuracy",
          label: "Factual accuracy",
          score: 0,
          maxScore: 10,
          status: "blocked",
          reason: "Fact gate must pass before QA can score accuracy.",
        },
      ],
    };
  }
  if (params.qualityPolicyReport.status !== "pass") {
    return {
      status: "blocked",
      score: 0,
      passThreshold,
      criticalFailures:
        params.qualityPolicyReport.criticalFailures.length > 0
          ? params.qualityPolicyReport.criticalFailures
          : params.qualityPolicyReport.checks
              .filter((check) => check.status === "blocked")
              .map((check) => check.id),
      rubric: params.qualityPolicyReport.checks.map((check) => ({
        id: check.id,
        label: check.id
          .split("-")
          .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
          .join(" "),
        score: 0,
        maxScore: check.severity === "critical" ? 15 : check.severity === "high" ? 10 : 5,
        status: "blocked",
        reason: check.reason,
      })),
    };
  }

  const rubric = [
    qaItem({
      id: "source-quality-citation-coverage",
      label: "Source quality and citation coverage",
      score: 15,
      maxScore: 15,
      reason: "Sources are snapshotted, tiered, checksummed, and cited by every claim.",
    }),
    qaItem({
      id: "curriculum-progression",
      label: "Curriculum progression",
      score: 14,
      maxScore: 15,
      reason: "The scaffold defines a clear gate-first learner path and package sequence.",
    }),
    qaItem({
      id: "lesson-clarity",
      label: "Lesson clarity and instructional flow",
      score: params.contentGenerationReport?.status === "pass" ? 14 : 13,
      maxScore: 15,
      reason:
        params.contentGenerationReport?.status === "pass"
          ? "The generated lesson explains semantic source claims with evidence excerpts and learner practice."
          : "The lesson is explicit about source-backed claims and non-publishable scope.",
    }),
    qaItem({
      id: "activities-practice",
      label: "Activities and learner practice",
      score: params.contentGenerationReport?.status === "pass" ? 9 : 8,
      maxScore: 10,
      reason:
        params.contentGenerationReport?.status === "pass"
          ? "Practice prompts are generated from the same verified semantic claim map."
          : "Practice requirements are represented through source-backed claims.",
    }),
    qaItem({
      id: "assessment-quality",
      label: "Assessment quality",
      score: params.contentGenerationReport?.status === "pass" ? 10 : 9,
      maxScore: 10,
      reason:
        params.contentGenerationReport?.status === "pass"
          ? "The quiz includes source-claim answer explanations and evidence source ids."
          : "The quiz includes an answer key that validates gate awareness for this package slice.",
    }),
    qaItem({
      id: "factual-accuracy",
      label: "Factual accuracy",
      score: 10,
      maxScore: 10,
      reason: "Every factual claim is verified against accepted source snapshot evidence.",
    }),
    qaItem({
      id: "accessibility-mobile-readiness",
      label: "Accessibility and mobile readiness",
      score: 8,
      maxScore: 10,
      reason: "Markdown artifacts use semantic headings and simple list structure.",
    }),
    qaItem({
      id: "originality-copyright-safety",
      label: "Originality and copyright safety",
      score: 5,
      maxScore: 5,
      reason: "Source-backed artifacts avoid proprietary source copying.",
    }),
    qaItem({
      id: "lms-package-readiness",
      label: "LMS package readiness",
      score: 5,
      maxScore: 5,
      reason:
        "Required artifact files exist with checksums; live Moodle publishing remains a separate gate.",
    }),
    qaItem({
      id: "brand-tone-consistency",
      label: "Brand and tone consistency",
      score: 5,
      maxScore: 5,
      reason: "Artifact language stays practical, explicit, and fail-closed.",
    }),
  ];
  const score = rubric.reduce((sum, item) => sum + item.score, 0);
  return {
    status: score >= passThreshold ? "pass" : "blocked",
    score,
    passThreshold,
    criticalFailures: [],
    rubric,
  };
}

function canGenerateSemanticLesson(params: {
  researchMode: CourseCreatorResearchMode;
  liveCrawlReport?: CourseCreatorLiveCrawlReport;
  claims: readonly CourseCreatorClaim[];
}): boolean {
  return (
    params.researchMode === "live_search" &&
    params.liveCrawlReport?.status === "pass" &&
    params.liveCrawlReport.semanticClaimsExtracted > 0 &&
    params.claims.some((claim) => (claim.evidenceSpans ?? []).length > 0)
  );
}

function buildContentGenerationReport(params: {
  semanticCourseGenerated: boolean;
  moduleCount: number;
  lessonCount: number;
  claims: readonly CourseCreatorClaim[];
  quizQuestionCount: number;
}): CourseCreatorContentGenerationReport {
  const evidenceSpanCount = params.claims.reduce(
    (count, claim) => count + (claim.evidenceSpans?.length ?? 0),
    0,
  );
  if (!params.semanticCourseGenerated) {
    return {
      status: "blocked",
      mode: "scaffold",
      moduleCount: 0,
      lessonCount: 1,
      activityCount: 0,
      quizQuestionCount: params.quizQuestionCount,
      sourceClaimCount: params.claims.length,
      evidenceSpanCount,
      requiredHumanActions: [
        "Generate learner-facing lessons only after semantic source claims and evidence spans exist.",
      ],
    };
  }
  return {
    status: "pass",
    mode: "multi_module_course",
    moduleCount: params.moduleCount,
    lessonCount: params.lessonCount,
    activityCount: params.lessonCount * 2,
    quizQuestionCount: params.quizQuestionCount,
    sourceClaimCount: params.claims.length,
    evidenceSpanCount,
    requiredHumanActions: [
      "Configure and certify live Moodle staging before production publishing.",
    ],
  };
}

function claimEvidenceExcerpt(claim: CourseCreatorClaim): string {
  return (
    claim.evidenceSpans?.find((span) => span.excerpt.trim())?.excerpt.trim() ??
    "Evidence is recorded in claim-map.json for the accepted source snapshot."
  );
}

type CourseCreatorGeneratedModule = {
  id: string;
  title: string;
  objective: string;
  claims: CourseCreatorClaim[];
};

type CourseCreatorGeneratedLesson = {
  id: string;
  moduleId: string;
  title: string;
  claims: CourseCreatorClaim[];
};

type CourseCreatorGeneratedCoursePlan = {
  modules: CourseCreatorGeneratedModule[];
  lessons: CourseCreatorGeneratedLesson[];
};

function chunkClaims(claims: readonly CourseCreatorClaim[], size: number): CourseCreatorClaim[][] {
  const chunks: CourseCreatorClaim[][] = [];
  for (let index = 0; index < claims.length; index += size) {
    chunks.push(claims.slice(index, index + size));
  }
  return chunks;
}

function buildSemanticCoursePlan(
  claims: readonly CourseCreatorClaim[],
): CourseCreatorGeneratedCoursePlan {
  const selectedClaims = claims.slice(0, 8);
  const claimGroups = chunkClaims(selectedClaims, 2);
  const modules = claimGroups.map((group, index) => ({
    id: `module-${String(index + 1).padStart(2, "0")}`,
    title: index === 0 ? "Foundations" : `Applied Practice ${index}`,
    objective:
      index === 0
        ? "Build the core mental model from verified source evidence."
        : "Apply verified source claims through learner practice and checks.",
    claims: group,
  }));
  const lessons = modules.map((module, index) => ({
    id: `lesson-${String(index + 1).padStart(2, "0")}`,
    moduleId: module.id,
    title: `${module.title}: ${module.claims[0]?.text.slice(0, 56) ?? "Source-backed lesson"}`,
    claims: module.claims,
  }));
  return { modules, lessons };
}

function buildSemanticModuleMarkdown(params: {
  topic: string;
  module: CourseCreatorGeneratedModule;
  lessonIds: readonly string[];
}): string {
  return [
    `# ${params.module.title}`,
    "",
    `Course: ${params.topic}`,
    "",
    `Objective: ${params.module.objective}`,
    "",
    "## Lessons",
    "",
    ...params.lessonIds.map((lessonId) => `- ${lessonId}`),
    "",
    "## Source Claim Coverage",
    "",
    ...params.module.claims.map(
      (claim) => `- ${claim.id}: ${claim.text} [sources: ${claim.sourceIds.join(", ")}]`,
    ),
    "",
  ].join("\n");
}

function buildSemanticLessonMarkdown(params: {
  topic: string;
  lesson: CourseCreatorGeneratedLesson;
}): string {
  const claims = params.lesson.claims;
  const keyIdeas = claims.flatMap((claim, index) => [
    `### Key idea ${index + 1}`,
    "",
    claim.text,
    "",
    `Evidence excerpt: ${claimEvidenceExcerpt(claim)}`,
    "",
    `Sources: ${claim.sourceIds.join(", ")}`,
    "",
  ]);
  const objectives = claims.map(
    (claim, index) => `- Explain key idea ${index + 1} using the cited source evidence.`,
  );
  const practicePrompts = claims
    .slice(0, 2)
    .map((claim, index) =>
      [
        `${index + 1}. Apply key idea ${index + 1}: ${claim.text}`,
        `   - Write one learner action that follows from this claim.`,
        `   - Cite the evidence excerpt before using the action in course material.`,
      ].join("\n"),
    );
  return [
    `# ${params.lesson.title}`,
    "",
    `Course: ${params.topic}`,
    "",
    `Module: ${params.lesson.moduleId}`,
    "",
    "Status: semantic-source-claim-backed instructional lesson.",
    "",
    "## Learning Objectives",
    "",
    ...objectives,
    "",
    "## Lesson",
    "",
    ...keyIdeas,
    "## Guided Practice",
    "",
    ...practicePrompts,
    "",
    "## Check Your Understanding",
    "",
    "Use the quiz artifact to check whether each answer is supported by the cited source evidence.",
    "",
    "## Publish Boundary",
    "",
    "This lesson is generated from verified source claims, but the course still needs live LMS certification and recovery proof before public publishing.",
    "",
  ].join("\n");
}

function buildScaffoldLessonMarkdown(params: {
  topic: string;
  researchMode: CourseCreatorResearchMode;
  liveCrawlReport?: CourseCreatorLiveCrawlReport;
  claims: readonly CourseCreatorClaim[];
}): string {
  if (params.researchMode === "none") {
    return [
      `# Lesson 1: ${params.topic}`,
      "",
      "This is a blocked scaffold, not a publishable lesson.",
      "",
      "The Course Creator must attach source-backed claims before generating learner-facing instruction.",
      "",
    ].join("\n");
  }
  const status =
    params.researchMode === "fixture"
      ? "Status: fixture-backed draft."
      : params.researchMode === "research_pack"
        ? "Status: research-pack-backed draft."
        : params.researchMode === "live_search"
          ? params.liveCrawlReport?.status === "pass"
            ? params.liveCrawlReport.semanticClaimsExtracted > 0
              ? "Status: live-crawl-semantic-claim-backed draft."
              : "Status: live-crawl-backed draft."
            : "Status: live-search-backed draft."
          : "Status: mock-search-backed draft.";
  return [
    `# Lesson 1: ${params.topic}`,
    "",
    status,
    "",
    "## Source-backed claims",
    "",
    ...params.claims.map((claim) => `- ${claim.text} [sources: ${claim.sourceIds.join(", ")}]`),
    "",
    "This fixture draft validates claim-map plumbing only and is not publishable course content.",
    "",
  ].join("\n");
}

function buildQuizPayload(params: {
  semanticCourseGenerated: boolean;
  claims: readonly CourseCreatorClaim[];
}): { schemaVersion: 1; status: "blocked" | "draft"; questions: unknown[] } {
  if (!params.semanticCourseGenerated) {
    return {
      schemaVersion: 1,
      status: "blocked",
      questions: [
        {
          id: "q1",
          type: "multiple_choice",
          prompt: "What must happen before this scaffold can become a publishable course?",
          choices: [
            "Pass source, fact, QA, publish, and recovery gates",
            "Skip source checks",
            "Publish directly",
          ],
          answer: "Pass source, fact, QA, publish, and recovery gates",
        },
      ],
    };
  }
  return {
    schemaVersion: 1,
    status: "draft",
    questions: params.claims.slice(0, 3).map((claim, index) => ({
      id: `q${index + 1}`,
      type: "multiple_choice",
      prompt: "Which statement is supported by the cited source evidence?",
      choices: [
        claim.text,
        "Course material can ignore source evidence after a draft exists.",
        "Public publishing can happen before LMS smoke and recovery gates pass.",
      ],
      answer: claim.text,
      explanation: `Supported by ${claim.sourceIds.join(", ")}: ${claimEvidenceExcerpt(claim)}`,
      evidenceSourceIds: claim.sourceIds,
    })),
  };
}

function blockedPublishReport(params: {
  mode: CourseCreatorPublishMode;
  target: CourseCreatorPublishReport["target"];
  adapter: CourseCreatorPublishReport["adapter"];
  reason: string;
  blockers: string[];
}): CourseCreatorPublishReport {
  return {
    status: params.mode === "none" ? "not_attempted" : "blocked",
    mode: params.mode,
    target: params.target,
    adapter: params.adapter,
    visibility: "none",
    publicPublishAllowed: false,
    courseId: null,
    courseUrl: null,
    evidencePath: null,
    events: [],
    smokeTest: {
      status: "blocked",
      checks: [],
    },
    recovery: {
      status: "blocked",
      exportPath: null,
      rollbackEvidence: null,
    },
    blockers: params.blockers,
    reason: params.reason,
  };
}

function buildLiveMoodleBlockedPublishReport(params: {
  report: CourseCreatorLiveMoodleStagingReport | undefined;
  reason: string;
  blockers: string[];
}): CourseCreatorPublishReport {
  return {
    status: "blocked",
    mode: "live_moodle_staging",
    target: "moodle",
    adapter: "live",
    visibility: "none",
    publicPublishAllowed: false,
    courseId: params.report?.courseId ?? null,
    courseUrl: params.report?.courseUrl ?? null,
    evidencePath: null,
    events: params.report?.events ?? [],
    smokeTest: params.report?.smokeTest ?? {
      status: "blocked",
      checks: [],
    },
    recovery: params.report?.recovery ?? {
      status: "blocked",
      exportPath: null,
      rollbackEvidence: null,
    },
    blockers: [...new Set([...(params.report?.blockers ?? []), ...params.blockers])],
    reason: params.reason,
  };
}

function buildPublishReport(params: {
  publishMode: CourseCreatorPublishMode;
  riskTier: CourseCreatorRiskTier;
  highRiskApprovalPassed: boolean;
  researchMode: CourseCreatorResearchMode;
  sourceCount: number;
  claimVerification: CourseCreatorClaimVerification;
  qaReport: CourseCreatorQaReport;
  liveMoodleStagingReport?: CourseCreatorLiveMoodleStagingReport;
  liveCrawlReport?: CourseCreatorLiveCrawlReport;
  contentGenerationReport?: CourseCreatorContentGenerationReport;
  jobId: string;
  slug: string;
  evidencePath: string;
}): CourseCreatorPublishReport {
  if (params.publishMode === "none") {
    return blockedPublishReport({
      mode: "none",
      target: "none",
      adapter: "none",
      reason: "No Moodle staging adapter is configured.",
      blockers: ["staging-publish-adapter-missing"],
    });
  }

  if (params.publishMode === "live_moodle_staging") {
    if (params.riskTier === "high" && !params.highRiskApprovalPassed) {
      return buildLiveMoodleBlockedPublishReport({
        report: params.liveMoodleStagingReport,
        reason: "High-risk topics require approval evidence before any live Moodle staging run.",
        blockers: ["high-risk-approval-evidence"],
      });
    }

    if (
      params.researchMode === "none" ||
      params.sourceCount < 2 ||
      params.claimVerification.status !== "pass" ||
      params.qaReport.status !== "pass"
    ) {
      return buildLiveMoodleBlockedPublishReport({
        report: params.liveMoodleStagingReport,
        reason: "Live Moodle staging requires source, fact, and QA gates to pass first.",
        blockers: ["source-fact-qa-prerequisites"],
      });
    }

    if (params.liveMoodleStagingReport?.status !== "pass") {
      return buildLiveMoodleBlockedPublishReport({
        report: params.liveMoodleStagingReport,
        reason: "Live Moodle staging certification has not passed.",
        blockers: ["live-moodle-staging-certification"],
      });
    }

    return {
      status: "pass",
      mode: "live_moodle_staging",
      target: "moodle",
      adapter: "live",
      visibility: "hidden",
      publicPublishAllowed: false,
      courseId: params.liveMoodleStagingReport.courseId,
      courseUrl: params.liveMoodleStagingReport.courseUrl,
      evidencePath: params.evidencePath,
      events: params.liveMoodleStagingReport.events,
      smokeTest: params.liveMoodleStagingReport.smokeTest,
      recovery: params.liveMoodleStagingReport.recovery,
      blockers: ["public-publish-canary-approval"],
      reason:
        "Live Moodle staging certification passed for a hidden course. Public publish still requires explicit canary approval.",
    };
  }

  if (params.riskTier === "high" && !params.highRiskApprovalPassed) {
    return blockedPublishReport({
      mode: params.publishMode,
      target: "moodle",
      adapter: "mock",
      reason: "High-risk topics require approval evidence before any staging publish proof.",
      blockers: ["high-risk-approval-evidence"],
    });
  }

  if (
    params.researchMode === "none" ||
    params.sourceCount < 2 ||
    params.claimVerification.status !== "pass" ||
    params.qaReport.status !== "pass"
  ) {
    return blockedPublishReport({
      mode: params.publishMode,
      target: "moodle",
      adapter: "mock",
      reason: "Mock Moodle staging requires source, fact, and QA gates to pass first.",
      blockers: ["source-fact-qa-prerequisites"],
    });
  }

  const courseId = `mock-moodle-${params.slug}-${shortHash(params.jobId)}`;
  const courseUrl = `mock://moodle/courses/${params.slug}`;
  const events = [
    {
      action: "create_hidden_course",
      status: "pass",
      evidence: `Created ${courseId} with visibility=hidden.`,
    },
    {
      action: "upload_lessons",
      status: "pass",
      evidence: `Uploaded ${params.contentGenerationReport?.lessonCount ?? 1} lesson artifact(s) into ${params.contentGenerationReport?.moduleCount ?? 1} section(s).`,
    },
    {
      action: "create_quiz",
      status: "pass",
      evidence: "Created quiz-01 with answer key metadata.",
    },
    {
      action: "set_completion_tracking",
      status: "pass",
      evidence: "Configured lesson view and quiz submission completion rules.",
    },
  ] satisfies CourseCreatorPublishEvent[];
  const smokeChecks = [
    {
      action: "student_preview_course",
      status: "pass",
      evidence: "Preview student can open the hidden staging course.",
    },
    {
      action: "complete_lesson",
      status: "pass",
      evidence: "Preview student can mark lesson-01 complete.",
    },
    {
      action: "submit_quiz",
      status: "pass",
      evidence: "Preview student can submit quiz-01 and receive the expected answer key result.",
    },
  ] satisfies CourseCreatorPublishEvent[];
  const sourceAutomationBlocker =
    params.researchMode === "research_pack"
      ? "automated-search-crawl-adapter"
      : params.researchMode === "mock_search_crawl"
        ? "live-search-provider-adapter"
        : params.researchMode === "live_search"
          ? params.liveCrawlReport?.status === "pass"
            ? params.liveCrawlReport.semanticClaimsExtracted > 0
              ? params.contentGenerationReport?.status === "pass"
                ? "live-moodle-staging-certification"
                : "learner-facing-lesson-generation-from-semantic-claims"
              : "semantic-claim-extraction-from-crawled-sources"
            : "live-page-crawl-content-extraction"
          : "live-research-adapter";

  return {
    status: "pass",
    mode: params.publishMode,
    target: "moodle",
    adapter: "mock",
    visibility: "hidden",
    publicPublishAllowed: false,
    courseId,
    courseUrl,
    evidencePath: params.evidencePath,
    events,
    smokeTest: {
      status: "pass",
      checks: smokeChecks,
    },
    recovery: {
      status: "pass",
      exportPath: `mock://moodle/backups/${courseId}.mbz`,
      rollbackEvidence: "Rollback proof keeps the staging course hidden after export.",
    },
    blockers: [sourceAutomationBlocker, "live-moodle-credentials"],
    reason:
      "Mock Moodle staging produced hidden-course, smoke-test, export, and rollback evidence. Real LMS credentials are still required before public publish.",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const raw = value[field];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${context} requires a non-empty ${field} string.`);
  }
  return raw.trim();
}

function requireSourceTier(value: Record<string, unknown>, context: string): "A" | "B" | "C" {
  const tier = requireStringField(value, "tier", context);
  if (tier !== "A" && tier !== "B" && tier !== "C") {
    throw new Error(`${context} tier must be A, B, or C.`);
  }
  return tier;
}

function requireCredibilityScore(value: Record<string, unknown>, context: string): number {
  const score = value.credibilityScore;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`${context} requires credibilityScore from 0 to 100.`);
  }
  if (score < 85) {
    throw new Error(`${context} credibilityScore must be at least 85 for source-gate proof.`);
  }
  return score;
}

function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} requires at least one source id.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${context} sourceIds[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

function parseClaimEvidenceSpans(
  value: unknown,
  context: string,
): CourseCreatorClaimEvidenceSpan[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} evidenceSpans must be an array when provided.`);
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`${context} evidenceSpans[${index}] must be an object.`);
    }
    return {
      sourceId: requireStringField(item, "sourceId", `${context} evidenceSpans[${index}]`),
      excerpt: requireStringField(item, "excerpt", `${context} evidenceSpans[${index}]`),
    };
  });
}

function parseResearchPackSource(
  value: unknown,
  index: number,
): CourseCreatorResearchPackSourceInput {
  const context = `Research pack source ${index + 1}`;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const content = requireStringField(value, "content", context);
  if (content.length < 80) {
    throw new Error(`${context} content must be at least 80 characters for snapshot proof.`);
  }
  return {
    id: requireStringField(value, "id", context),
    title: requireStringField(value, "title", context),
    url: requireStringField(value, "url", context),
    publisher: requireStringField(value, "publisher", context),
    tier: requireSourceTier(value, context),
    credibilityScore: requireCredibilityScore(value, context),
    license: requireStringField(value, "license", context),
    content,
  };
}

function parseResearchPackClaim(
  value: unknown,
  index: number,
): CourseCreatorResearchPackClaimInput {
  const context = `Research pack claim ${index + 1}`;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const lessonId = value.lessonId;
  if (lessonId !== undefined && (typeof lessonId !== "string" || !lessonId.trim())) {
    throw new Error(`${context} lessonId must be a non-empty string when provided.`);
  }
  return {
    id: requireStringField(value, "id", context),
    lessonId: typeof lessonId === "string" ? lessonId.trim() : undefined,
    text: requireStringField(value, "text", context),
    sourceIds: parseStringArray(value.sourceIds, context),
    evidenceSpans: parseClaimEvidenceSpans(value.evidenceSpans, context),
  };
}

function requireReportStatus(
  value: Record<string, unknown>,
  context: string,
): CourseCreatorGateStatus {
  const status = requireStringField(value, "status", context);
  if (status !== "pass" && status !== "blocked") {
    throw new Error(`${context} status must be pass or blocked.`);
  }
  return status;
}

function parseNullableStringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  const raw = value[field];
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${context} ${field} must be a non-empty string or null.`);
  }
  return raw.trim();
}

function parseStringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${context}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

function parseApprovalScope(
  value: Record<string, unknown>,
  context: string,
): CourseCreatorApprovalScope {
  const scope = requireStringField(value, "scope", context);
  if (scope !== "high_risk_course_review" && scope !== "public_publish_canary") {
    throw new Error(`${context} scope must be high_risk_course_review or public_publish_canary.`);
  }
  return scope;
}

function parseApprovalDecision(
  value: Record<string, unknown>,
  context: string,
): CourseCreatorApprovalDecision {
  const decision = requireStringField(value, "decision", context);
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`${context} decision must be approved or rejected.`);
  }
  return decision;
}

function parseApprovalEvidenceInput(
  value: unknown,
  context = "Approval evidence",
): CourseCreatorApprovalEvidence {
  if (!isObject(value)) {
    throw new Error(`${context} must be a JSON object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${context} schemaVersion must be 1.`);
  }
  return {
    schemaVersion: 1,
    scope: parseApprovalScope(value, context),
    decision: parseApprovalDecision(value, context),
    topic: requireStringField(value, "topic", context),
    reviewerName: requireStringField(value, "reviewerName", context),
    reviewerRole: requireStringField(value, "reviewerRole", context),
    approvedAt: requireStringField(value, "approvedAt", context),
    expiresAt: parseNullableStringField(value, "expiresAt", context),
    evidence: requireStringField(value, "evidence", context),
    limitations: parseStringList(value.limitations ?? [], `${context} limitations`),
  };
}

export function readCourseCreatorApprovalEvidence(
  approvalPath: string,
): CourseCreatorApprovalEvidence {
  const resolvedPath = path.resolve(approvalPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read approval evidence ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseApprovalEvidenceInput(parsed);
}

function isApprovedHighRiskEvidence(params: {
  evidence: CourseCreatorApprovalEvidence | undefined;
  topic: string;
  createdAt: string;
}): boolean {
  if (!params.evidence) {
    return false;
  }
  if (
    params.evidence.scope !== "high_risk_course_review" ||
    params.evidence.decision !== "approved"
  ) {
    return false;
  }
  if (params.evidence.topic.trim().toLowerCase() !== params.topic.trim().toLowerCase()) {
    return false;
  }
  const approvedAt = Date.parse(params.evidence.approvedAt);
  const createdAt = Date.parse(params.createdAt);
  if (!Number.isFinite(approvedAt) || approvedAt > createdAt) {
    return false;
  }
  if (params.evidence.expiresAt) {
    const expiresAt = Date.parse(params.evidence.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      return false;
    }
  }
  return true;
}

function parsePublishEvent(
  value: unknown,
  index: number,
  context: string,
): CourseCreatorPublishEvent {
  const eventContext = `${context}[${index}]`;
  if (!isObject(value)) {
    throw new Error(`${eventContext} must be an object.`);
  }
  const status = requireStringField(value, "status", eventContext);
  if (status !== "pass" && status !== "blocked" && status !== "failed") {
    throw new Error(`${eventContext} status must be pass, blocked, or failed.`);
  }
  return {
    action: requireStringField(value, "action", eventContext),
    status,
    evidence: requireStringField(value, "evidence", eventContext),
  };
}

function parsePublishEvents(value: unknown, context: string): CourseCreatorPublishEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }
  return value.map((item, index) => parsePublishEvent(item, index, context));
}

function parseLiveMoodleChecklistItem(
  value: unknown,
  index: number,
): CourseCreatorLiveMoodleStagingChecklistItem {
  const context = `Live Moodle staging checklist ${index + 1}`;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const status = requireStringField(value, "status", context);
  if (status !== "present" && status !== "missing" && status !== "failed") {
    throw new Error(`${context} status must be present, missing, or failed.`);
  }
  return {
    id: requireStringField(value, "id", context),
    status,
    source: requireStringField(value, "source", context),
    message: requireStringField(value, "message", context),
  };
}

function parseLiveMoodleStagingReportInput(
  value: unknown,
  context = "Live Moodle staging report",
): CourseCreatorLiveMoodleStagingReport {
  if (!isObject(value)) {
    throw new Error(`${context} must be a JSON object.`);
  }
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    throw new Error(`${context} schemaVersion must be 1 when provided.`);
  }
  const status = requireReportStatus(value, context);
  const checkedAt = requireStringField(value, "checkedAt", context);
  const courseId = parseNullableStringField(value, "courseId", context);
  const courseUrl = parseNullableStringField(value, "courseUrl", context);
  const events = parsePublishEvents(value.events, `${context} events`);

  if (!isObject(value.smokeTest)) {
    throw new Error(`${context} smokeTest must be an object.`);
  }
  const smokeStatus = requireReportStatus(value.smokeTest, `${context} smokeTest`);
  const smokeChecks = parsePublishEvents(value.smokeTest.checks, `${context} smokeTest.checks`);

  if (!isObject(value.recovery)) {
    throw new Error(`${context} recovery must be an object.`);
  }
  const recoveryStatus = requireReportStatus(value.recovery, `${context} recovery`);
  const recovery = {
    status: recoveryStatus,
    exportPath: parseNullableStringField(value.recovery, "exportPath", `${context} recovery`),
    rollbackEvidence: parseNullableStringField(
      value.recovery,
      "rollbackEvidence",
      `${context} recovery`,
    ),
  };

  const blockers = parseStringList(value.blockers, `${context} blockers`);
  const checklistValue = value.checklist;
  if (!Array.isArray(checklistValue)) {
    throw new Error(`${context} checklist must be an array.`);
  }
  const checklist = checklistValue.map(parseLiveMoodleChecklistItem);
  const requiredHumanActions = parseStringList(
    value.requiredHumanActions,
    `${context} requiredHumanActions`,
  );
  const reason = requireStringField(value, "reason", context);

  if (status === "pass") {
    if (!courseId || !courseUrl) {
      throw new Error(`${context} requires courseId and courseUrl when status is pass.`);
    }
    if (events.length === 0 || events.some((event) => event.status !== "pass")) {
      throw new Error(`${context} requires all publish events to pass when status is pass.`);
    }
    if (
      smokeStatus !== "pass" ||
      smokeChecks.length === 0 ||
      smokeChecks.some((event) => event.status !== "pass")
    ) {
      throw new Error(`${context} requires passing smoke checks when status is pass.`);
    }
    if (recoveryStatus !== "pass" || !recovery.exportPath || !recovery.rollbackEvidence) {
      throw new Error(`${context} requires export and rollback evidence when status is pass.`);
    }
    if (checklist.length === 0 || checklist.some((item) => item.status !== "present")) {
      throw new Error(`${context} requires all checklist items to be present when status is pass.`);
    }
  }

  return {
    status,
    checkedAt,
    courseId,
    courseUrl,
    events,
    smokeTest: {
      status: smokeStatus,
      checks: smokeChecks,
    },
    recovery,
    blockers,
    checklist,
    requiredHumanActions,
    reason,
  };
}

export function readCourseCreatorLiveMoodleStagingReport(
  reportPath: string,
): CourseCreatorLiveMoodleStagingReport {
  const resolvedPath = path.resolve(reportPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read live Moodle staging report ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseLiveMoodleStagingReportInput(parsed);
}

function readResearchPackInput(researchPackPath: string): CourseCreatorResearchPackInput {
  const resolvedPath = path.resolve(researchPackPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read research pack ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isObject(parsed)) {
    throw new Error("Research pack must be a JSON object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Research pack schemaVersion must be 1.");
  }
  if (!Array.isArray(parsed.sources) || parsed.sources.length < 2) {
    throw new Error("Research pack must include at least two credible sources.");
  }
  if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) {
    throw new Error("Research pack must include source-backed claims.");
  }

  const sources = parsed.sources.map(parseResearchPackSource);
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Research pack source id is duplicated: ${source.id}`);
    }
    sourceIds.add(source.id);
  }

  const claims = parsed.claims.map(parseResearchPackClaim);
  for (const claim of claims) {
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`Research pack claim ${claim.id} references missing source: ${sourceId}`);
      }
    }
    for (const span of claim.evidenceSpans ?? []) {
      if (!sourceIds.has(span.sourceId)) {
        throw new Error(
          `Research pack claim ${claim.id} evidence span references missing source: ${span.sourceId}`,
        );
      }
    }
  }

  return { schemaVersion: 1, sources, claims };
}

function validateResearchPackInput(
  researchPack: CourseCreatorResearchPackInput,
  label: string,
): CourseCreatorResearchPackInput {
  if (researchPack.schemaVersion !== 1) {
    throw new Error(`${label} schemaVersion must be 1.`);
  }
  if (!Array.isArray(researchPack.sources) || researchPack.sources.length < 2) {
    throw new Error(`${label} must include at least two credible sources.`);
  }
  if (!Array.isArray(researchPack.claims) || researchPack.claims.length === 0) {
    throw new Error(`${label} must include source-backed claims.`);
  }
  const sources = researchPack.sources.map((source, index) =>
    parseResearchPackSource(source, index),
  );
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`${label} source id is duplicated: ${source.id}`);
    }
    sourceIds.add(source.id);
  }
  const claims = researchPack.claims.map((claim, index) => parseResearchPackClaim(claim, index));
  for (const claim of claims) {
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`${label} claim ${claim.id} references missing source: ${sourceId}`);
      }
    }
    for (const span of claim.evidenceSpans ?? []) {
      if (!sourceIds.has(span.sourceId)) {
        throw new Error(
          `${label} claim ${claim.id} evidence span references missing source: ${span.sourceId}`,
        );
      }
    }
  }
  return { schemaVersion: 1, sources, claims };
}

function snapshotFileName(sourceId: string): string {
  return `${slugifyCourseTopic(sourceId).slice(0, 80) || "source"}.txt`;
}

function buildFixtureResearchSources(params: {
  topic: string;
  slug: string;
  retrievedAt: string;
}): Array<Omit<CourseCreatorSourceSnapshot, "snapshotPath" | "checksum"> & { content: string }> {
  const baseUrl = `fixture://course-creator/${params.slug}`;
  return [
    {
      id: "fixture-official-overview",
      title: `${params.topic} official overview fixture`,
      url: `${baseUrl}/official-overview`,
      publisher: "OpenClaw Course Creator Fixture Authority",
      tier: "A",
      credibilityScore: 92,
      retrievedAt: params.retrievedAt,
      license: "fixture-only",
      content: [
        `Topic: ${params.topic}`,
        "Purpose: deterministic source snapshot plumbing test.",
        "Use: validates source inventory, snapshot checksums, and source gate behavior.",
        "Limitation: not a live factual authority for public course content.",
      ].join("\n"),
    },
    {
      id: "fixture-curriculum-standard",
      title: `${params.topic} curriculum standard fixture`,
      url: `${baseUrl}/curriculum-standard`,
      publisher: "OpenClaw Course Creator Fixture Standards",
      tier: "A",
      credibilityScore: 90,
      retrievedAt: params.retrievedAt,
      license: "fixture-only",
      content: [
        `Topic: ${params.topic}`,
        "Course packages should include learning objectives, lessons, assessment metadata, and gate evidence.",
        "Every public course requires source, fact, QA, publish, smoke, and recovery proof.",
      ].join("\n"),
    },
    {
      id: "fixture-learner-practice",
      title: `${params.topic} learner practice fixture`,
      url: `${baseUrl}/learner-practice`,
      publisher: "OpenClaw Course Creator Fixture Practice Library",
      tier: "B",
      credibilityScore: 88,
      retrievedAt: params.retrievedAt,
      license: "fixture-only",
      content: [
        `Topic: ${params.topic}`,
        "Good course packages include practice activities, answer keys, and revision metadata.",
        "Practice content must be checked against the approved source pack before publishing.",
      ].join("\n"),
    },
  ];
}

function buildMockSearchCrawlSources(params: {
  topic: string;
  slug: string;
  retrievedAt: string;
}): Array<Omit<CourseCreatorSourceSnapshot, "snapshotPath" | "checksum"> & { content: string }> {
  const baseUrl = `mock-search://course-creator/${params.slug}`;
  return [
    {
      id: "mock-search-institutional-guide",
      title: `${params.topic} institutional guide`,
      url: `${baseUrl}/institutional-guide`,
      publisher: "OpenClaw Mock Search Institutional Index",
      tier: "A",
      credibilityScore: 91,
      retrievedAt: params.retrievedAt,
      license: "mock-search-contract",
      content: [
        `Topic: ${params.topic}`,
        "Mock search result: institutional guide selected by the deterministic course search contract.",
        "Teaching use: source packs must include credible publisher metadata, retrieval time, and immutable snapshots before generation.",
        "Limitation: this is not live factual authority; it proves topic-only search/crawl plumbing offline.",
      ].join("\n"),
    },
    {
      id: "mock-search-practice-standard",
      title: `${params.topic} practice standard`,
      url: `${baseUrl}/practice-standard`,
      publisher: "OpenClaw Mock Search Standards Index",
      tier: "A",
      credibilityScore: 89,
      retrievedAt: params.retrievedAt,
      license: "mock-search-contract",
      content: [
        `Topic: ${params.topic}`,
        "Mock crawl result: practice standards should be converted into learning objectives, activities, and quiz checks only after source acceptance.",
        "Teaching use: claim extraction must cite accepted source ids rather than loose URLs.",
        "Limitation: replace this adapter with live crawl snapshots before production courses.",
      ].join("\n"),
    },
    {
      id: "mock-search-assessment-reference",
      title: `${params.topic} assessment reference`,
      url: `${baseUrl}/assessment-reference`,
      publisher: "OpenClaw Mock Search Assessment Index",
      tier: "B",
      credibilityScore: 88,
      retrievedAt: params.retrievedAt,
      license: "mock-search-contract",
      content: [
        `Topic: ${params.topic}`,
        "Mock crawl result: course packages should include answer-key validation, QA scoring, publish evidence, smoke checks, and rollback proof.",
        "Teaching use: publishing remains blocked until every gate has auditable evidence.",
        "Limitation: this source exists to test automated search/crawl control flow without network access.",
      ].join("\n"),
    },
  ];
}

function findSourceOrThrow(
  sources: readonly CourseCreatorSourceSnapshot[],
  sourceId: string,
): CourseCreatorSourceSnapshot {
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new Error(`Course claim references missing source: ${sourceId}`);
  }
  return source;
}

function claimEvidence(
  sources: readonly CourseCreatorSourceSnapshot[],
  sourceIds: string[],
): CourseCreatorClaimEvidence[] {
  return sourceIds.map((sourceId) => {
    const source = findSourceOrThrow(sources, sourceId);
    return {
      sourceId: source.id,
      snapshotPath: source.snapshotPath,
      checksum: source.checksum,
    };
  });
}

function buildFixtureClaims(params: {
  topic: string;
  sources: readonly CourseCreatorSourceSnapshot[];
}): CourseCreatorClaim[] {
  const claims = [
    {
      id: "claim-course-package-components",
      lessonId: "lesson-01",
      text: `A ${params.topic} course package should include learning objectives, lessons, assessment metadata, and gate evidence.`,
      sourceIds: ["fixture-curriculum-standard"],
    },
    {
      id: "claim-public-course-gates",
      lessonId: "lesson-01",
      text: "Every public course requires source, fact, QA, publish, smoke, and recovery proof.",
      sourceIds: ["fixture-curriculum-standard"],
    },
    {
      id: "claim-practice-source-check",
      lessonId: "lesson-01",
      text: "Practice content must be checked against the approved source pack before publishing.",
      sourceIds: ["fixture-learner-practice"],
    },
  ];

  return claims.map((claim) =>
    Object.assign({}, claim, {
      status: "verified" as const,
      evidence: claimEvidence(params.sources, claim.sourceIds),
      confidence: 1,
      notes: "Deterministic fixture claim verified against local source snapshot metadata.",
    }),
  );
}

function buildResearchPackClaims(params: {
  claims: readonly CourseCreatorResearchPackClaimInput[];
  sources: readonly CourseCreatorSourceSnapshot[];
  label?: string;
  confidence?: number;
}): CourseCreatorClaim[] {
  return params.claims.map((claim) => ({
    id: claim.id,
    lessonId: claim.lessonId ?? "lesson-01",
    text: claim.text,
    sourceIds: claim.sourceIds,
    status: "verified",
    evidence: claimEvidence(params.sources, claim.sourceIds),
    evidenceSpans: claim.evidenceSpans,
    confidence: params.confidence ?? 0.95,
    notes: `${params.label ?? "Configured research-pack"} claim verified against local source snapshot metadata.`,
  }));
}

function buildMockSearchCrawlClaims(params: {
  topic: string;
  sources: readonly CourseCreatorSourceSnapshot[];
}): CourseCreatorClaim[] {
  const claims = [
    {
      id: "claim-topic-only-source-pack",
      lessonId: "lesson-01",
      text: `A ${params.topic} course request can create a source pack automatically when search results include credible publisher metadata, retrieval time, and immutable snapshots.`,
      sourceIds: ["mock-search-institutional-guide"],
    },
    {
      id: "claim-source-id-citations",
      lessonId: "lesson-01",
      text: "Claim extraction must cite accepted source ids rather than loose URLs.",
      sourceIds: ["mock-search-practice-standard"],
    },
    {
      id: "claim-publish-gate-evidence",
      lessonId: "lesson-01",
      text: "Publishing remains blocked until every gate has auditable evidence.",
      sourceIds: ["mock-search-assessment-reference"],
    },
  ];

  return claims.map((claim) =>
    Object.assign({}, claim, {
      status: "verified" as const,
      evidence: claimEvidence(params.sources, claim.sourceIds),
      confidence: 0.98,
      notes: "Mock search/crawl claim verified against deterministic source snapshot metadata.",
    }),
  );
}

export function verifyCourseCreatorClaims(
  claims: readonly CourseCreatorClaim[],
  sources: readonly CourseCreatorSourceSnapshot[],
): CourseCreatorClaimVerification {
  const sourceIds = new Set(sources.map((source) => source.id));
  const missingSourceIds = new Set<string>();
  let verified = 0;
  let unsupported = 0;

  for (const claim of claims) {
    const missingForClaim = claim.sourceIds.filter((sourceId) => !sourceIds.has(sourceId));
    for (const sourceId of missingForClaim) {
      missingSourceIds.add(sourceId);
    }
    if (
      claim.status === "verified" &&
      claim.sourceIds.length > 0 &&
      missingForClaim.length === 0 &&
      claim.evidence.length === claim.sourceIds.length
    ) {
      verified += 1;
    } else {
      unsupported += 1;
    }
  }

  return {
    status: claims.length > 0 && unsupported === 0 && missingSourceIds.size === 0 ? "pass" : "fail",
    verified,
    unsupported,
    missingSourceIds: [...missingSourceIds].toSorted(),
  };
}

function writeJson(filePath: string, value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, content, "utf8");
  return checksum(content);
}

function writeText(filePath: string, content: string): string {
  fs.writeFileSync(filePath, content, "utf8");
  return checksum(content);
}

function artifact(id: string, filePath: string, digest: string): CourseCreatorArtifact {
  return { id, path: filePath, checksum: digest };
}

export function validateCourseCreatorArtifacts(artifacts: readonly CourseCreatorArtifact[]): {
  status: "pass" | "fail";
  missing: string[];
  checksumMismatches: string[];
} {
  const missing: string[] = [];
  const checksumMismatches: string[] = [];
  for (const item of artifacts) {
    if (!fs.existsSync(item.path)) {
      missing.push(item.id);
      continue;
    }
    const content = fs.readFileSync(item.path, "utf8");
    if (checksum(content) !== item.checksum) {
      checksumMismatches.push(item.id);
    }
  }
  return {
    status: missing.length === 0 && checksumMismatches.length === 0 ? "pass" : "fail",
    missing,
    checksumMismatches,
  };
}

export function createCourseCreatorPackage(
  options: CreateCourseCreatorPackageOptions,
): CourseCreatorPackageResult {
  const topic = normalizeTopic(options.topic);
  const createdAt = (options.now ?? new Date()).toISOString();
  const slug = slugifyCourseTopic(topic);
  const jobId = `${slug}-${shortHash(topic)}`;
  const riskTier = classifyRisk(topic);
  const researchMode = options.researchMode ?? "none";
  const publishMode = options.publishMode ?? "none";
  const status: CourseCreatorStatus = riskTier === "high" ? "draft_only" : "blocked";
  const liveMoodleStagingReport = options.liveMoodleStagingReport
    ? parseLiveMoodleStagingReportInput(
        options.liveMoodleStagingReport,
        "Live Moodle staging report input",
      )
    : undefined;
  const approvalEvidence = options.approvalEvidence
    ? parseApprovalEvidenceInput(options.approvalEvidence, "Approval evidence input")
    : options.approvalEvidencePath
      ? readCourseCreatorApprovalEvidence(options.approvalEvidencePath)
      : undefined;
  const highRiskApprovalPassed = isApprovedHighRiskEvidence({
    evidence: approvalEvidence,
    topic,
    createdAt,
  });
  const outputDir = path.resolve(options.outputRoot, slug);
  if (options.approvalEvidencePath && options.approvalEvidence) {
    throw new Error("Use either approvalEvidencePath or approvalEvidence, not both.");
  }
  if (publishMode !== "live_moodle_staging" && liveMoodleStagingReport) {
    throw new Error("liveMoodleStagingReport can only be used with live_moodle_staging mode.");
  }
  if (researchMode === "research_pack" && !options.researchPackPath && !options.researchPackInput) {
    throw new Error("research_pack mode requires researchPackPath.");
  }
  if (researchMode !== "research_pack" && options.researchPackPath) {
    throw new Error("researchPackPath can only be used with research_pack mode.");
  }
  if (
    options.researchPackInput &&
    researchMode !== "research_pack" &&
    researchMode !== "live_search"
  ) {
    throw new Error("researchPackInput can only be used with research_pack or live_search mode.");
  }
  const researchPack =
    options.researchPackInput &&
    (researchMode === "research_pack" || researchMode === "live_search")
      ? validateResearchPackInput(options.researchPackInput, "Research pack input")
      : researchMode === "research_pack" && options.researchPackPath
        ? readResearchPackInput(options.researchPackPath)
        : null;

  fs.mkdirSync(path.join(outputDir, "sources"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "sources", "snapshots"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "modules"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "quizzes"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "publish"), { recursive: true });

  const artifacts: CourseCreatorArtifact[] = [];
  const courseYamlPath = path.join(outputDir, "course.yaml");
  artifacts.push(
    artifact(
      "course-yaml",
      courseYamlPath,
      writeText(
        courseYamlPath,
        createCourseYaml({
          jobId,
          topic,
          slug,
          status,
          riskTier,
          researchMode,
          publishMode,
          createdAt,
        }),
      ),
    ),
  );

  const sources: CourseCreatorSourceSnapshot[] = [];
  if (researchMode === "fixture") {
    for (const source of buildFixtureResearchSources({ topic, slug, retrievedAt: createdAt })) {
      const snapshotPath = path.join(
        outputDir,
        "sources",
        "snapshots",
        snapshotFileName(source.id),
      );
      const digest = writeText(snapshotPath, `${source.content}\n`);
      sources.push({
        id: source.id,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        tier: source.tier,
        credibilityScore: source.credibilityScore,
        retrievedAt: source.retrievedAt,
        license: source.license,
        snapshotPath,
        checksum: digest,
      });
      artifacts.push(artifact(`source-snapshot-${source.id}`, snapshotPath, digest));
    }
  } else if (researchMode === "mock_search_crawl") {
    for (const source of buildMockSearchCrawlSources({ topic, slug, retrievedAt: createdAt })) {
      const snapshotPath = path.join(
        outputDir,
        "sources",
        "snapshots",
        snapshotFileName(source.id),
      );
      const digest = writeText(snapshotPath, `${source.content}\n`);
      sources.push({
        id: source.id,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        tier: source.tier,
        credibilityScore: source.credibilityScore,
        retrievedAt: source.retrievedAt,
        license: source.license,
        snapshotPath,
        checksum: digest,
      });
      artifacts.push(artifact(`source-snapshot-${source.id}`, snapshotPath, digest));
    }
  } else if ((researchMode === "research_pack" || researchMode === "live_search") && researchPack) {
    for (const source of researchPack.sources) {
      const snapshotPath = path.join(
        outputDir,
        "sources",
        "snapshots",
        snapshotFileName(source.id),
      );
      const digest = writeText(snapshotPath, `${source.content.trim()}\n`);
      sources.push({
        id: source.id,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        tier: source.tier,
        credibilityScore: source.credibilityScore,
        retrievedAt: createdAt,
        license: source.license,
        snapshotPath,
        checksum: digest,
      });
      artifacts.push(artifact(`source-snapshot-${source.id}`, snapshotPath, digest));
    }
  }

  const claims =
    researchMode === "fixture"
      ? buildFixtureClaims({ topic, sources })
      : researchMode === "mock_search_crawl"
        ? buildMockSearchCrawlClaims({ topic, sources })
        : (researchMode === "research_pack" || researchMode === "live_search") && researchPack
          ? buildResearchPackClaims({
              claims: researchPack.claims,
              sources,
              label: researchMode === "live_search" ? "Live search" : "Configured research-pack",
              confidence: researchMode === "live_search" ? 0.9 : 0.95,
            })
          : ([] as CourseCreatorClaim[]);
  const claimVerification = verifyCourseCreatorClaims(claims, sources);
  const semanticCourseGenerated = canGenerateSemanticLesson({
    researchMode,
    liveCrawlReport: options.liveCrawlReport,
    claims,
  });
  const semanticCoursePlan = semanticCourseGenerated ? buildSemanticCoursePlan(claims) : null;
  const quizPayload = buildQuizPayload({ semanticCourseGenerated, claims });
  const contentGenerationReport = buildContentGenerationReport({
    semanticCourseGenerated,
    moduleCount: semanticCoursePlan?.modules.length ?? 0,
    lessonCount: semanticCoursePlan?.lessons.length ?? 1,
    claims,
    quizQuestionCount: quizPayload.questions.length,
  });
  const qualityPolicyReport = buildCourseCreatorQualityPolicyReport({
    sources,
    claims,
    claimVerification,
    contentGenerationReport,
    quizPayload,
    semanticCourseGenerated,
  });
  const qaReport = buildQaReport({
    researchMode,
    claimVerification,
    claims,
    sources,
    qualityPolicyReport,
    contentGenerationReport,
  });
  const publishEvidencePath = path.join(
    outputDir,
    "publish",
    publishMode === "live_moodle_staging"
      ? "live-moodle-staging-evidence.json"
      : "mock-moodle-staging-evidence.json",
  );
  const publishReport = buildPublishReport({
    publishMode,
    riskTier,
    highRiskApprovalPassed,
    researchMode,
    sourceCount: sources.length,
    claimVerification,
    qaReport,
    liveMoodleStagingReport,
    liveCrawlReport: options.liveCrawlReport,
    contentGenerationReport,
    jobId,
    slug,
    evidencePath: publishEvidencePath,
  });
  const gates = buildGates(
    riskTier,
    highRiskApprovalPassed,
    researchMode,
    sources.length,
    claimVerification,
    qaReport,
    publishReport,
  );
  const requiredHumanActions = buildRequiredHumanActions(
    riskTier,
    highRiskApprovalPassed,
    researchMode,
    publishMode,
    options.liveSearchReport,
    options.liveCrawlReport,
    liveMoodleStagingReport,
    contentGenerationReport,
  );
  const nextBuildGap = buildNextBuildGap(
    riskTier,
    highRiskApprovalPassed,
    researchMode,
    publishMode,
    claimVerification,
    qaReport,
    publishReport,
    options.liveCrawlReport,
    contentGenerationReport,
  );

  const sourcePackPath = path.join(outputDir, "sources", "source-pack.json");
  artifacts.push(
    artifact(
      "source-pack",
      sourcePackPath,
      writeJson(sourcePackPath, {
        schemaVersion: 1,
        status: sources.length >= 2 ? "pass" : "blocked",
        mode: researchMode,
        reason:
          researchMode === "fixture"
            ? "Deterministic fixture research snapshots were generated for local contract testing."
            : researchMode === "research_pack"
              ? "Configured research pack sources were snapshotted for local contract testing."
              : researchMode === "mock_search_crawl"
                ? "Mock search/crawl sources were generated from topic-only input for local contract testing."
                : researchMode === "live_search" && options.liveCrawlReport?.status === "pass"
                  ? options.liveCrawlReport.semanticClaimsExtracted > 0
                    ? "Live web_search candidates were fetched through guarded web_fetch and converted into semantic source-backed claims."
                    : "Live web_search candidates were fetched and extracted through guarded web_fetch."
                  : researchMode === "live_search" && sources.length >= 2
                    ? "Live web_search source candidates were snapshotted for local contract testing."
                    : researchMode === "live_search"
                      ? "Live web_search did not produce enough accepted source candidates."
                      : "No research adapter is configured in this artifact-only slice.",
        sources,
        liveSearchReport: options.liveSearchReport,
        liveCrawlReport: options.liveCrawlReport,
        requiredNextStep:
          researchMode === "fixture"
            ? "Replace fixture sources with live search/crawl/snapshot adapters."
            : researchMode === "research_pack"
              ? "Replace per-course research pack input with automated search/crawl/snapshot adapters."
              : researchMode === "mock_search_crawl"
                ? "Replace mocked search/crawl with live source search, crawl, and snapshot adapters."
                : researchMode === "live_search" && options.liveCrawlReport?.status === "pass"
                  ? options.liveCrawlReport.semanticClaimsExtracted > 0
                    ? contentGenerationReport.status === "pass"
                      ? "Certify live Moodle staging publish, smoke, export, and rollback evidence."
                      : "Generate learner-facing lessons, activities, and quizzes from semantic source-backed claims."
                    : "Extract semantic factual claims and evidence spans from crawled source text."
                  : researchMode === "live_search" && sources.length >= 2
                    ? "Fetch accepted result URLs and snapshot extracted page content for real course grounding."
                    : researchMode === "live_search"
                      ? "Configure web_search provider credentials/network access and rerun live search."
                      : "Connect source search, crawl, and snapshot adapters.",
      }),
    ),
  );

  const curriculumPath = path.join(outputDir, "curriculum.md");
  artifacts.push(
    artifact(
      "curriculum",
      curriculumPath,
      writeText(
        curriculumPath,
        [
          `# ${topic}`,
          "",
          "Status: blocked draft.",
          "",
          "## Intended learner path",
          "",
          "1. Define the learner outcome.",
          "2. Research and snapshot credible sources.",
          "3. Build modules only from accepted source evidence.",
          "4. Run fact, QA, publish, and recovery gates.",
          "",
        ].join("\n"),
      ),
    ),
  );

  if (semanticCoursePlan) {
    for (const module of semanticCoursePlan.modules) {
      const modulePath = path.join(outputDir, "modules", `${module.id}.md`);
      const lessonIds = semanticCoursePlan.lessons
        .filter((lesson) => lesson.moduleId === module.id)
        .map((lesson) => lesson.id);
      artifacts.push(
        artifact(
          module.id,
          modulePath,
          writeText(modulePath, buildSemanticModuleMarkdown({ topic, module, lessonIds })),
        ),
      );
    }
    for (const lesson of semanticCoursePlan.lessons) {
      const lessonPath = path.join(outputDir, "lessons", `${lesson.id}.md`);
      artifacts.push(
        artifact(
          lesson.id,
          lessonPath,
          writeText(lessonPath, buildSemanticLessonMarkdown({ topic, lesson })),
        ),
      );
    }
  } else {
    const lessonPath = path.join(outputDir, "lessons", "lesson-01.md");
    artifacts.push(
      artifact(
        "lesson-01",
        lessonPath,
        writeText(
          lessonPath,
          buildScaffoldLessonMarkdown({
            topic,
            researchMode,
            liveCrawlReport: options.liveCrawlReport,
            claims,
          }),
        ),
      ),
    );
  }

  const quizPath = path.join(outputDir, "quizzes", "quiz-01.json");
  artifacts.push(artifact("quiz-01", quizPath, writeJson(quizPath, quizPayload)));

  const claimMapPath = path.join(outputDir, "claim-map.json");
  artifacts.push(
    artifact(
      "claim-map",
      claimMapPath,
      writeJson(claimMapPath, {
        schemaVersion: 1,
        status: claimVerification.status,
        verification: claimVerification,
        claims,
        reason:
          claimVerification.status === "pass"
            ? "All claims are linked to accepted source snapshot evidence."
            : "No factual lesson claims are allowed before source snapshots exist.",
      }),
    ),
  );

  const qaReportPath = path.join(outputDir, "qa-report.json");
  artifacts.push(
    artifact(
      "qa-report",
      qaReportPath,
      writeJson(qaReportPath, {
        schemaVersion: 1,
        ...qaReport,
        gates,
      }),
    ),
  );

  const qualityPolicyReportPath = path.join(outputDir, "quality-policy-report.json");
  artifacts.push(
    artifact(
      "quality-policy-report",
      qualityPolicyReportPath,
      writeJson(qualityPolicyReportPath, {
        schemaVersion: 1,
        ...qualityPolicyReport,
      }),
    ),
  );

  const contentGenerationReportPath = path.join(outputDir, "content-generation-report.json");
  artifacts.push(
    artifact(
      "content-generation-report",
      contentGenerationReportPath,
      writeJson(contentGenerationReportPath, {
        schemaVersion: 1,
        ...contentGenerationReport,
      }),
    ),
  );

  if (researchMode === "live_search" && options.liveSearchReport) {
    const liveSearchReportPath = path.join(outputDir, "sources", "live-search-report.json");
    artifacts.push(
      artifact(
        "live-search-report",
        liveSearchReportPath,
        writeJson(liveSearchReportPath, {
          schemaVersion: 1,
          ...options.liveSearchReport,
        }),
      ),
    );
  }

  if (researchMode === "live_search" && options.liveCrawlReport) {
    const liveCrawlReportPath = path.join(outputDir, "sources", "live-crawl-report.json");
    artifacts.push(
      artifact(
        "live-crawl-report",
        liveCrawlReportPath,
        writeJson(liveCrawlReportPath, {
          schemaVersion: 1,
          ...options.liveCrawlReport,
        }),
      ),
    );
  }

  if (publishReport.status === "pass" && publishReport.evidencePath) {
    artifacts.push(
      artifact(
        "publish-evidence",
        publishReport.evidencePath,
        writeJson(publishReport.evidencePath, {
          schemaVersion: 1,
          mode: publishReport.mode,
          target: publishReport.target,
          adapter: publishReport.adapter,
          courseId: publishReport.courseId,
          courseUrl: publishReport.courseUrl,
          visibility: publishReport.visibility,
          events: publishReport.events,
          smokeTest: publishReport.smokeTest,
          recovery: publishReport.recovery,
        }),
      ),
    );
  }

  if (publishMode === "live_moodle_staging" && liveMoodleStagingReport) {
    const liveMoodleReportPath = path.join(outputDir, "publish", "live-moodle-staging-report.json");
    artifacts.push(
      artifact(
        "live-moodle-staging-report",
        liveMoodleReportPath,
        writeJson(liveMoodleReportPath, {
          schemaVersion: 1,
          ...liveMoodleStagingReport,
        }),
      ),
    );
  }

  if (approvalEvidence) {
    const approvalEvidencePath = path.join(outputDir, "approval-evidence.json");
    artifacts.push(
      artifact(
        "approval-evidence",
        approvalEvidencePath,
        writeJson(approvalEvidencePath, {
          ...approvalEvidence,
          acceptedForHighRiskGate: highRiskApprovalPassed,
        }),
      ),
    );
  }

  const publishReportPath = path.join(outputDir, "publish-report.json");
  artifacts.push(
    artifact(
      "publish-report",
      publishReportPath,
      writeJson(publishReportPath, {
        schemaVersion: 1,
        ...publishReport,
      }),
    ),
  );

  const selfImprovementPath = path.join(outputDir, "self-improvement-report.json");
  artifacts.push(
    artifact(
      "self-improvement-report",
      selfImprovementPath,
      writeJson(selfImprovementPath, {
        schemaVersion: 1,
        status: "observe",
        safeAutoAppliedChanges: [],
        reviewRequiredChanges: ["source adapter", "publisher adapter", "threshold policy"],
        nextBuildGap,
      }),
    ),
  );

  const nextGapPath = path.join(outputDir, "next-build-gap.json");
  artifacts.push(artifact("next-build-gap", nextGapPath, writeJson(nextGapPath, nextBuildGap)));

  const validation = validateCourseCreatorArtifacts(artifacts);
  if (validation.status !== "pass") {
    throw new Error(
      `Course Creator artifact validation failed: missing=${validation.missing.join(",") || "none"} checksumMismatches=${validation.checksumMismatches.join(",") || "none"}`,
    );
  }

  return {
    schemaVersion: 1,
    jobId,
    topic,
    slug,
    status,
    riskTier,
    researchMode,
    publishMode,
    outputDir,
    artifacts,
    gates,
    sources,
    claims,
    qaReport,
    qualityPolicyReport,
    publishReport,
    contentGenerationReport,
    liveSearchReport: options.liveSearchReport,
    liveCrawlReport: options.liveCrawlReport,
    liveMoodleStagingReport,
    approvalEvidence,
    requiredHumanActions,
    nextBuildGap,
  };
}
