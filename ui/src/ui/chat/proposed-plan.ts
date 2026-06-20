export type ProposedPlanStatus = "drafting" | "awaiting_approval" | "ready" | "blocked";

export type ProposedPlanMarkdownSegment = {
  kind: "markdown";
  markdown: string;
};

export type ProposedPlanCardSegment = {
  kind: "proposed_plan";
  id: string;
  markdown: string;
  raw: string;
  status: ProposedPlanStatus;
  implementationPrompt: string;
  missingCloseTag?: boolean;
  unmatchedCloseTag?: boolean;
};

export type ProposedPlanSegment = ProposedPlanMarkdownSegment | ProposedPlanCardSegment;

export type ParseProposedPlanOptions = {
  isStreaming?: boolean;
  composerDraft?: string | null;
};

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";
const IMPLEMENT_PLAN_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";

function appendMarkdownSegment(segments: ProposedPlanSegment[], markdown: string): void {
  if (markdown) {
    segments.push({ kind: "markdown", markdown });
  }
}

function normalizePlanMarkdown(markdown: string): string {
  return markdown.replace(/^\s*\n/u, "").replace(/[ \t\r\n]+$/u, "");
}

function normalizeComparable(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

export function buildProposedPlanImplementationPrompt(planMarkdown: string): string {
  return `${IMPLEMENT_PLAN_PREFIX}\n${normalizePlanMarkdown(planMarkdown)}`;
}

function resolvePlanStatus(
  status: Exclude<ProposedPlanStatus, "ready">,
  implementationPrompt: string,
  composerDraft: string | null | undefined,
): ProposedPlanStatus {
  if (
    status !== "blocked" &&
    composerDraft &&
    normalizeComparable(composerDraft).includes(normalizeComparable(implementationPrompt))
  ) {
    return "ready";
  }
  return status;
}

function buildPlanSegment(params: {
  index: number;
  raw: string;
  markdown: string;
  status: Exclude<ProposedPlanStatus, "ready">;
  composerDraft?: string | null;
  missingCloseTag?: boolean;
  unmatchedCloseTag?: boolean;
}): ProposedPlanCardSegment {
  const markdown = normalizePlanMarkdown(params.markdown);
  const implementationPrompt = buildProposedPlanImplementationPrompt(markdown);
  return {
    kind: "proposed_plan",
    id: `proposed-plan-${params.index}`,
    markdown,
    raw: params.raw,
    implementationPrompt,
    status: resolvePlanStatus(params.status, implementationPrompt, params.composerDraft),
    ...(params.missingCloseTag ? { missingCloseTag: true } : {}),
    ...(params.unmatchedCloseTag ? { unmatchedCloseTag: true } : {}),
  };
}

export function parseProposedPlanSegments(
  markdown: string,
  options: ParseProposedPlanOptions = {},
): ProposedPlanSegment[] {
  const segments: ProposedPlanSegment[] = [];
  let cursor = 0;
  let planIndex = 0;

  while (cursor < markdown.length) {
    const nextOpen = markdown.indexOf(OPEN_TAG, cursor);
    const nextClose = markdown.indexOf(CLOSE_TAG, cursor);

    if (nextOpen === -1 && nextClose === -1) {
      appendMarkdownSegment(segments, markdown.slice(cursor));
      break;
    }

    if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
      appendMarkdownSegment(segments, markdown.slice(cursor, nextClose));
      const raw = markdown.slice(nextClose, nextClose + CLOSE_TAG.length);
      segments.push(
        buildPlanSegment({
          index: planIndex++,
          raw,
          markdown: "Malformed plan block: closing tag appeared before an opening tag.",
          status: "blocked",
          composerDraft: options.composerDraft,
          unmatchedCloseTag: true,
        }),
      );
      cursor = nextClose + CLOSE_TAG.length;
      continue;
    }

    appendMarkdownSegment(segments, markdown.slice(cursor, nextOpen));
    const contentStart = nextOpen + OPEN_TAG.length;
    const close = markdown.indexOf(CLOSE_TAG, contentStart);
    if (close === -1) {
      const raw = markdown.slice(nextOpen);
      segments.push(
        buildPlanSegment({
          index: planIndex,
          raw,
          markdown: markdown.slice(contentStart),
          status: options.isStreaming ? "drafting" : "blocked",
          composerDraft: options.composerDraft,
          missingCloseTag: true,
        }),
      );
      break;
    }

    const raw = markdown.slice(nextOpen, close + CLOSE_TAG.length);
    segments.push(
      buildPlanSegment({
        index: planIndex++,
        raw,
        markdown: markdown.slice(contentStart, close),
        status: "awaiting_approval",
        composerDraft: options.composerDraft,
      }),
    );
    cursor = close + CLOSE_TAG.length;
  }

  return segments;
}

export function hasProposedPlanSegment(segments: readonly ProposedPlanSegment[]): boolean {
  return segments.some((segment) => segment.kind === "proposed_plan");
}

export function stripProposedPlanTagsForMarkdown(markdown: string): string {
  return parseProposedPlanSegments(markdown)
    .map((segment) => (segment.kind === "markdown" ? segment.markdown : segment.markdown))
    .join("\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
