import type {
  SkillProposalManifestEntry,
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalReviewResult,
  SkillProposalReviewUnavailableReason,
  SkillProposalStatus,
} from "../../skills/workshop/types.js";
import { ToolInputError } from "./common.js";

const REVIEW_UNAVAILABLE_MESSAGES = {
  "proposal-changed": "The proposal changed without matching metadata.",
  "target-changed": "The live target changed after this proposal was created.",
  "target-missing": "The live skill no longer exists.",
  "diff-limit": "The diff exceeded the bounded review limits.",
  "output-limit": "The complete review exceeds the bounded conversation output limit.",
} satisfies Record<SkillProposalReviewUnavailableReason, string>;
// Live tool/channel projections cap text at 8k; leave room for review metadata.
const SKILL_PROPOSAL_REVIEW_PAGE_CHARS = 7000;
// A diff line must fit one page so later pages retain its +/- marker.
const SKILL_PROPOSAL_REVIEW_DIFF_LINE_CHARS = 6000;
// Each page recomputes drift checks, so bound the total review workflow as well as each result.
const SKILL_PROPOSAL_REVIEW_MAX_PAGES = 16;

export function listProposalEntries(params: {
  proposals: readonly SkillProposalManifestEntry[];
  status?: SkillProposalStatus;
  query?: string;
  limit: number;
}): SkillProposalManifestEntry[] {
  const query = params.query?.trim().toLowerCase();
  const normalizedQuery = query ? normalizeProposalSearchText(query) : undefined;
  const limit = Math.min(Math.max(params.limit, 1), 50);
  // Pending proposals sort first so the model sees actionable work before
  // historical applied/rejected records.
  return params.proposals
    .filter((proposal) => !params.status || proposal.status === params.status)
    .filter((proposal) => {
      if (!query) {
        return true;
      }
      return [
        proposal.id,
        proposal.title,
        proposal.description,
        proposal.skillName,
        proposal.skillKey,
      ].some((value) => {
        const lower = value.toLowerCase();
        return (
          lower.includes(query) ||
          (normalizedQuery !== undefined &&
            normalizedQuery.length > 0 &&
            normalizeProposalSearchText(lower).includes(normalizedQuery))
        );
      });
    })
    .toSorted((a, b) => {
      if (a.status === "pending" && b.status !== "pending") {
        return -1;
      }
      if (a.status !== "pending" && b.status === "pending") {
        return 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit);
}

function normalizeProposalSearchText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

export function formatProposalList(proposals: readonly SkillProposalManifestEntry[]): string {
  if (proposals.length === 0) {
    return "No skill proposals matched.";
  }
  return proposals
    .map(
      (proposal) =>
        `- ${proposal.id} [${proposal.status}, ${proposal.kind}, ${proposal.scanState}] ${proposal.skillKey}: ${proposal.title}`,
    )
    .join("\n");
}

type ReviewTextPage = {
  text: string;
  page: number;
  pageCount: number;
  totalChars: number;
};

export function formatProposalReviewResult(
  review: SkillProposalReviewResult,
  requestedPage: number,
) {
  let boundedReview = boundReviewForTool(review);
  let pagination = paginateReviewText(
    formatProposalReviewBody(boundedReview),
    boundedReview.mode === "unavailable" ? 1 : requestedPage,
  );
  if (pagination.pageCount > SKILL_PROPOSAL_REVIEW_MAX_PAGES) {
    boundedReview = { record: review.record, mode: "unavailable", reason: "output-limit" };
    pagination = paginateReviewText(formatProposalReviewBody(boundedReview), 1);
  }
  return {
    content: [{ type: "text" as const, text: formatProposalReview(boundedReview, pagination) }],
    details: {
      ...proposalDetails(boundedReview.record),
      reviewMode: boundedReview.mode,
      page: pagination.page,
      pageCount: pagination.pageCount,
      totalChars: pagination.totalChars,
      ...(boundedReview.mode === "unavailable" ? { unavailableReason: boundedReview.reason } : {}),
    },
  };
}

function boundReviewForTool(review: SkillProposalReviewResult): SkillProposalReviewResult {
  if (
    review.mode === "diff" &&
    review.diff.split("\n").some((line) => line.length > SKILL_PROPOSAL_REVIEW_DIFF_LINE_CHARS)
  ) {
    return { record: review.record, mode: "unavailable", reason: "diff-limit" };
  }
  return review;
}

function paginateReviewText(text: string, requestedPage: number): ReviewTextPage {
  const pages: string[] = [];
  let page = "";
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    let line = text.slice(start, end);
    while (line.length > SKILL_PROPOSAL_REVIEW_PAGE_CHARS) {
      if (page) {
        pages.push(page);
        page = "";
      }
      const chunkEnd = safeReviewPageEnd(line, SKILL_PROPOSAL_REVIEW_PAGE_CHARS);
      pages.push(line.slice(0, chunkEnd));
      line = line.slice(chunkEnd);
    }
    if (page && page.length + line.length > SKILL_PROPOSAL_REVIEW_PAGE_CHARS) {
      pages.push(page);
      page = "";
    }
    page += line;
    start = end;
  }
  if (page || pages.length === 0) {
    pages.push(page);
  }
  const textPage = pages[requestedPage - 1];
  if (textPage === undefined) {
    throw new ToolInputError(`review page must be between 1 and ${pages.length}`);
  }
  return {
    text: textPage,
    page: requestedPage,
    pageCount: pages.length,
    totalChars: text.length,
  };
}

function safeReviewPageEnd(text: string, maximum: number): number {
  const end = Math.min(maximum, text.length);
  const lastCodeUnit = text.charCodeAt(end - 1);
  return end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end;
}

function formatProposalReview(review: SkillProposalReviewResult, page: ReviewTextPage): string {
  return [
    `Proposal: ${review.record.id}`,
    `Version: ${review.record.proposedVersion}`,
    `Status: ${review.record.status}`,
    `Kind: ${review.record.kind}`,
    `Skill: ${review.record.target.skillKey}`,
    `Scan: ${review.record.scan.state}`,
    `Review: ${review.mode}`,
    `Page: ${page.page}/${page.pageCount}`,
    "",
    page.text,
  ].join("\n");
}

function formatProposalReviewBody(review: SkillProposalReviewResult): string {
  if (review.mode === "diff") {
    return review.diff || "No changes would be applied.";
  }
  if (review.mode === "unavailable") {
    return `Review unavailable: ${REVIEW_UNAVAILABLE_MESSAGES[review.reason]}`;
  }
  const supportFiles = review.supportFiles.flatMap((file) => [
    "",
    `--- ${file.path} ---`,
    file.content,
  ]);
  return ["--- SKILL.md ---", review.content, ...supportFiles].join("\n");
}

function proposalDetails(record: SkillProposalRecord) {
  return {
    id: record.id,
    status: record.status,
    kind: record.kind,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    targetSkillFile: record.target.skillFile,
    scanState: record.scan.state,
    proposedVersion: record.proposedVersion,
  };
}

export function formatProposalInspect(proposal: SkillProposalReadResult): string {
  const supportFiles =
    proposal.supportFiles && proposal.supportFiles.length > 0
      ? [
          "",
          "Support files:",
          ...proposal.supportFiles.flatMap((file) => ["", `--- ${file.path} ---`, file.content]),
        ]
      : [];
  return [
    `Proposal: ${proposal.record.id}`,
    `Status: ${proposal.record.status}`,
    `Kind: ${proposal.record.kind}`,
    `Skill: ${proposal.record.target.skillKey}`,
    `Version: ${proposal.record.proposedVersion}`,
    `Scan: ${proposal.record.scan.state}`,
    "",
    proposal.content,
    ...supportFiles,
  ].join("\n");
}
