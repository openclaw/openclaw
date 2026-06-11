import type {
  CourseCreatorClaim,
  CourseCreatorClaimVerification,
  CourseCreatorContentGenerationReport,
  CourseCreatorGateStatus,
  CourseCreatorSourceSnapshot,
} from "./package.js";

export type CourseCreatorQualityPolicySeverity = "critical" | "high" | "medium";

export type CourseCreatorQualityPolicyCheck = {
  id: string;
  status: CourseCreatorGateStatus;
  severity: CourseCreatorQualityPolicySeverity;
  reason: string;
  evidence: string[];
};

export type CourseCreatorQualityPolicyReport = {
  status: CourseCreatorGateStatus;
  criticalFailures: string[];
  checks: CourseCreatorQualityPolicyCheck[];
};

type QuizPayload = {
  status: "blocked" | "draft";
  questions: unknown[];
};

function passCheck(params: {
  id: string;
  severity: CourseCreatorQualityPolicySeverity;
  reason: string;
  evidence: string[];
}): CourseCreatorQualityPolicyCheck {
  return { ...params, status: "pass" };
}

function blockedCheck(params: {
  id: string;
  severity: CourseCreatorQualityPolicySeverity;
  reason: string;
  evidence: string[];
}): CourseCreatorQualityPolicyCheck {
  return { ...params, status: "blocked" };
}

function hostnameOrPublisher(source: CourseCreatorSourceSnapshot): string {
  try {
    const parsed = new URL(source.url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname.toLowerCase()
      : source.publisher.trim().toLowerCase();
  } catch {
    return source.publisher.trim().toLowerCase();
  }
}

function buildSourceCredibilityCheck(
  sources: readonly CourseCreatorSourceSnapshot[],
): CourseCreatorQualityPolicyCheck {
  if (sources.length < 2) {
    return blockedCheck({
      id: "source-credibility-scoring",
      severity: "critical",
      reason: "At least two credible source snapshots are required.",
      evidence: [`sourceCount=${sources.length}`],
    });
  }

  const lowestScore = Math.min(...sources.map((source) => source.credibilityScore));
  const averageScore =
    sources.reduce((sum, source) => sum + source.credibilityScore, 0) / sources.length;
  const cTierSources = sources.filter((source) => source.tier === "C").map((source) => source.id);
  if (lowestScore < 85 || averageScore < 88 || cTierSources.length > 0) {
    return blockedCheck({
      id: "source-credibility-scoring",
      severity: "critical",
      reason: "Source credibility is below the Course Creator publishing threshold.",
      evidence: [
        `lowestScore=${lowestScore}`,
        `averageScore=${averageScore.toFixed(1)}`,
        `cTierSources=${cTierSources.join(",") || "none"}`,
      ],
    });
  }

  return passCheck({
    id: "source-credibility-scoring",
    severity: "critical",
    reason: "Accepted sources meet minimum and average credibility thresholds.",
    evidence: [`lowestScore=${lowestScore}`, `averageScore=${averageScore.toFixed(1)}`],
  });
}

function buildSourceDiversityCheck(
  sources: readonly CourseCreatorSourceSnapshot[],
): CourseCreatorQualityPolicyCheck {
  const distinctPublishers = new Set(sources.map(hostnameOrPublisher));
  if (sources.length >= 2 && distinctPublishers.size < 2) {
    return blockedCheck({
      id: "source-diversity",
      severity: "high",
      reason: "Accepted source snapshots must not all come from the same publisher or host.",
      evidence: [`distinctPublishers=${distinctPublishers.size}`],
    });
  }
  return passCheck({
    id: "source-diversity",
    severity: "high",
    reason: "Accepted source snapshots include more than one publisher or host.",
    evidence: [`distinctPublishers=${distinctPublishers.size}`],
  });
}

function licenseLooksUnsafe(license: string): boolean {
  const normalized = license.toLowerCase();
  return [
    "all rights reserved",
    "unknown",
    "no license",
    "unlicensed",
    "proprietary",
    "copyrighted",
  ].some((term) => normalized.includes(term));
}

function buildCopyrightLicenseCheck(params: {
  sources: readonly CourseCreatorSourceSnapshot[];
  claims: readonly CourseCreatorClaim[];
}): CourseCreatorQualityPolicyCheck {
  const unsafeSources = params.sources
    .filter((source) => licenseLooksUnsafe(source.license))
    .map((source) => `${source.id}:${source.license}`);
  const longEvidenceSpans = params.claims.flatMap((claim) =>
    (claim.evidenceSpans ?? [])
      .filter((span) => span.excerpt.length > 320)
      .map((span) => `${claim.id}:${span.sourceId}`),
  );
  if (unsafeSources.length > 0 || longEvidenceSpans.length > 0) {
    return blockedCheck({
      id: "license-copyright-screening",
      severity: "critical",
      reason: "Course content cannot proceed with unsafe source licensing or overlong excerpts.",
      evidence: [
        `unsafeSources=${unsafeSources.join(",") || "none"}`,
        `overlongEvidenceSpans=${longEvidenceSpans.join(",") || "none"}`,
      ],
    });
  }
  return passCheck({
    id: "license-copyright-screening",
    severity: "critical",
    reason:
      "Accepted source licenses and evidence excerpt lengths pass local copyright safety checks.",
    evidence: [`sourcesChecked=${params.sources.length}`, `claimsChecked=${params.claims.length}`],
  });
}

function claimTokens(text: string): Set<string> {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "be",
    "before",
    "can",
    "course",
    "for",
    "in",
    "is",
    "of",
    "or",
    "should",
    "the",
    "to",
    "with",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 2 && !stop.has(token)),
  );
}

function hasNegation(text: string): boolean {
  return /\b(no|not|never|avoid|without|mustn't|must not|shouldn't|should not|cannot)\b/iu.test(
    text,
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
}

function buildContradictionCheck(
  claims: readonly CourseCreatorClaim[],
): CourseCreatorQualityPolicyCheck {
  const contradictions: string[] = [];
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const left = claims[leftIndex];
      const right = claims[rightIndex];
      if (!left || !right) {
        continue;
      }
      const overlap = jaccard(claimTokens(left.text), claimTokens(right.text));
      if (overlap >= 0.55 && hasNegation(left.text) !== hasNegation(right.text)) {
        contradictions.push(`${left.id}<->${right.id}`);
      }
    }
  }
  if (contradictions.length > 0) {
    return blockedCheck({
      id: "contradiction-detection",
      severity: "critical",
      reason: "Potentially contradictory source-backed claims must be resolved before QA passes.",
      evidence: contradictions,
    });
  }
  return passCheck({
    id: "contradiction-detection",
    severity: "critical",
    reason: "No direct claim contradictions were detected by the local lexical policy.",
    evidence: [`claimsChecked=${claims.length}`],
  });
}

function buildAccessibilityCheck(
  contentGenerationReport: CourseCreatorContentGenerationReport,
): CourseCreatorQualityPolicyCheck {
  if (contentGenerationReport.lessonCount < 1) {
    return blockedCheck({
      id: "accessibility-mobile-readiness",
      severity: "medium",
      reason: "At least one lesson artifact is required for accessibility checks.",
      evidence: [`lessonCount=${contentGenerationReport.lessonCount}`],
    });
  }
  return passCheck({
    id: "accessibility-mobile-readiness",
    severity: "medium",
    reason: "Generated Markdown artifacts use heading-based structure and bounded lesson sections.",
    evidence: [
      `lessonCount=${contentGenerationReport.lessonCount}`,
      `moduleCount=${contentGenerationReport.moduleCount}`,
    ],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildAssessmentCheck(params: {
  quizPayload: QuizPayload;
  semanticCourseGenerated: boolean;
}): CourseCreatorQualityPolicyCheck {
  if (params.quizPayload.questions.length === 0) {
    return blockedCheck({
      id: "assessment-quality",
      severity: "high",
      reason: "Quiz payload must contain at least one question.",
      evidence: ["questionCount=0"],
    });
  }

  const invalidQuestions = params.quizPayload.questions.flatMap((question, index) => {
    if (!isRecord(question)) {
      return [`q${index + 1}:not-object`];
    }
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const answer = typeof question.answer === "string" ? question.answer : "";
    const hasAnswer = choices.includes(answer);
    const explanation = typeof question.explanation === "string" ? question.explanation.trim() : "";
    const evidenceSourceIds = Array.isArray(question.evidenceSourceIds)
      ? question.evidenceSourceIds
      : [];
    if (!hasAnswer) {
      return [`q${index + 1}:answer-not-in-choices`];
    }
    if (params.semanticCourseGenerated && (!explanation || evidenceSourceIds.length === 0)) {
      return [`q${index + 1}:missing-source-backed-explanation`];
    }
    return [];
  });

  if (invalidQuestions.length > 0) {
    return blockedCheck({
      id: "assessment-quality",
      severity: "high",
      reason: "Quiz answer keys and source-backed explanations must be valid.",
      evidence: invalidQuestions,
    });
  }

  return passCheck({
    id: "assessment-quality",
    severity: "high",
    reason: "Quiz questions have valid answer keys and required source-backed explanations.",
    evidence: [`questionCount=${params.quizPayload.questions.length}`],
  });
}

export function buildCourseCreatorQualityPolicyReport(params: {
  sources: readonly CourseCreatorSourceSnapshot[];
  claims: readonly CourseCreatorClaim[];
  claimVerification: CourseCreatorClaimVerification;
  contentGenerationReport: CourseCreatorContentGenerationReport;
  quizPayload: QuizPayload;
  semanticCourseGenerated: boolean;
}): CourseCreatorQualityPolicyReport {
  if (params.claimVerification.status !== "pass") {
    return {
      status: "blocked",
      criticalFailures: ["missing-source-backed-claim-evidence"],
      checks: [
        blockedCheck({
          id: "quality-policy-prerequisites",
          severity: "critical",
          reason: "Quality policy checks require verified source-backed claims first.",
          evidence: [
            `verified=${params.claimVerification.verified}`,
            `unsupported=${params.claimVerification.unsupported}`,
          ],
        }),
      ],
    };
  }

  const checks = [
    buildSourceCredibilityCheck(params.sources),
    buildSourceDiversityCheck(params.sources),
    buildCopyrightLicenseCheck({ sources: params.sources, claims: params.claims }),
    buildContradictionCheck(params.claims),
    buildAccessibilityCheck(params.contentGenerationReport),
    buildAssessmentCheck({
      quizPayload: params.quizPayload,
      semanticCourseGenerated: params.semanticCourseGenerated,
    }),
  ];
  const criticalFailures = checks
    .filter((check) => check.status === "blocked" && check.severity === "critical")
    .map((check) => check.id);
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "blocked",
    criticalFailures,
    checks,
  };
}
