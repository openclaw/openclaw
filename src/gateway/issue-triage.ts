export const ISSUE_TRIAGE_AUTO_FIX_LABEL = "iyen:auto-fix";
export const ISSUE_TRIAGE_DECLINED_LABEL = "iyen:declined";
export const ISSUE_TRIAGE_COMMENT_MARKER = "<!-- openclaw:issue-triage:declined -->";

export type IssueTriageDecision = "delegate" | "close";

export type IssueTriageClassification = {
  decision: IssueTriageDecision;
  reason?: string;
  details?: string;
  commentBody?: string;
};

export type IssueTriageIssue = {
  repo: string;
  number: number;
  title: string;
  html_url?: string;
  labels: string[];
  body_preview?: string;
  state?: string;
  locked?: boolean;
};

export type IssueTriageService = {
  getIssue?: (repo: string, issueNumber: number) => Promise<IssueTriageIssue>;
  classifyIssue: (issue: IssueTriageIssue) => Promise<unknown>;
  addLabels: (repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  createComment: (repo: string, issueNumber: number, body: string) => Promise<void>;
  hasExistingTriageComment?: (repo: string, issueNumber: number) => Promise<boolean>;
};

export type IssueTriageResult =
  | { ok: true; status: "noop"; reason: "already-triaged" | "closed" | "locked" }
  | { ok: true; status: "labeled"; decision: "delegate" | "close"; commentCreated?: boolean }
  | { ok: false; httpStatus: 400 | 502 | 503; error: string };

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const label = entry.trim();
      if (label) {
        labels.push(label);
      }
      continue;
    }
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { name?: unknown }).name === "string"
    ) {
      const label = (entry as { name: string }).name.trim();
      if (label) {
        labels.push(label);
      }
    }
  }
  return labels;
}

export function extractIssueTriagePayloadJson(text: string): string | undefined {
  const marker = "Payload:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const afterMarker = text.slice(markerIndex + marker.length).trim();
  if (!afterMarker.startsWith("{")) {
    return undefined;
  }
  return afterMarker;
}

export function parseIssueTriageText(
  text: unknown,
): { ok: true; issue: IssueTriageIssue } | { ok: false; error: string } {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return { ok: false, error: "text required" };
  }
  const jsonText = extractIssueTriagePayloadJson(normalizedText);
  if (!jsonText) {
    return { ok: false, error: "Payload JSON required" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "Payload JSON is invalid" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Payload JSON must be an object" };
  }
  const payload = parsed as Record<string, unknown>;
  const repo = normalizeString(payload.repo);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { ok: false, error: "Payload repo must be owner/name" };
  }
  const number = payload.number;
  if (!Number.isInteger(number) || (number as number) <= 0) {
    return { ok: false, error: "Payload number must be a positive integer" };
  }
  const title = normalizeString(payload.title);
  if (!title) {
    return { ok: false, error: "Payload title required" };
  }
  return {
    ok: true,
    issue: {
      repo,
      number: number as number,
      title,
      html_url: normalizeString(payload.html_url),
      labels: normalizeLabels(payload.labels),
      body_preview: normalizeString(payload.body_preview),
      state: normalizeString(payload.state)?.toLowerCase(),
      locked: payload.locked === true,
    },
  };
}

export function resolveIssueTriageNoopReason(
  issue: IssueTriageIssue,
): "already-triaged" | "closed" | "locked" | undefined {
  const labelSet = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (
    labelSet.has(ISSUE_TRIAGE_AUTO_FIX_LABEL.toLowerCase()) ||
    labelSet.has(ISSUE_TRIAGE_DECLINED_LABEL.toLowerCase())
  ) {
    return "already-triaged";
  }
  if (issue.state?.toLowerCase() === "closed") {
    return "closed";
  }
  if (issue.locked === true) {
    return "locked";
  }
  return undefined;
}

function tryParseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

export function normalizeIssueTriageClassification(
  value: unknown,
): IssueTriageClassification | undefined {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "delegate" || normalized === "close") {
      return { decision: normalized };
    }
    const parsed = tryParseJsonObject(value.trim());
    if (parsed !== undefined) {
      return normalizeIssueTriageClassification(parsed);
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as {
      decision?: unknown;
      reason?: unknown;
      details?: unknown;
      comment_body?: unknown;
      commentBody?: unknown;
    };
    const decisionValue = normalizeIssueTriageClassification(record.decision)?.decision;
    if (!decisionValue) {
      return undefined;
    }
    return {
      decision: decisionValue,
      reason: normalizeString(record.reason),
      details: normalizeString(record.details),
      commentBody: normalizeString(record.commentBody) ?? normalizeString(record.comment_body),
    };
  }
  return undefined;
}

export function normalizeIssueTriageDecision(value: unknown): IssueTriageDecision | undefined {
  return normalizeIssueTriageClassification(value)?.decision;
}

export function buildIssueTriageDeclineComment(
  issue: IssueTriageIssue,
  classification?: Pick<IssueTriageClassification, "reason" | "details" | "commentBody">,
): string {
  const custom = normalizeString(classification?.commentBody);
  if (custom && !custom.includes("iyensystem:context-report")) {
    return custom.includes(ISSUE_TRIAGE_COMMENT_MARKER)
      ? custom
      : `${ISSUE_TRIAGE_COMMENT_MARKER}\n${custom}`;
  }
  const reason = classification?.reason ?? "Not suitable for an automatic fix PR";
  const details =
    classification?.details ??
    `OpenClaw reviewed ${issue.html_url ?? `${issue.repo}#${issue.number}`} and will not delegate it to the auto-fix workflow.`;
  return `${ISSUE_TRIAGE_COMMENT_MARKER}\n🤖 OpenClaw triage\n\nThis issue was reviewed automatically and won't be picked up for an\nauto-fix PR.\n\n**Reason**: ${reason}\n**Details**: ${details}\n\nIf you disagree, remove the \`${ISSUE_TRIAGE_DECLINED_LABEL}\` label and reopen — a human\nmaintainer can re-triage.\n\n<sub>agent: openclaw-triage</sub>`;
}

export async function triageIssue(
  inputIssue: IssueTriageIssue,
  service: IssueTriageService,
): Promise<IssueTriageResult> {
  let issue = inputIssue;
  if (service.getIssue) {
    try {
      issue = await service.getIssue(inputIssue.repo, inputIssue.number);
    } catch {
      return { ok: false, httpStatus: 502, error: "GitHub issue API failed" };
    }
  }
  const noopReason = resolveIssueTriageNoopReason(issue);
  if (noopReason) {
    return { ok: true, status: "noop", reason: noopReason };
  }

  let rawDecision: unknown;
  try {
    rawDecision = await service.classifyIssue(issue);
  } catch {
    return { ok: false, httpStatus: 503, error: "issue triage classifier failed" };
  }
  const classification = normalizeIssueTriageClassification(rawDecision);
  if (!classification) {
    return {
      ok: false,
      httpStatus: 502,
      error: "issue triage classifier returned an unknown decision",
    };
  }
  const decision = classification.decision;

  if (decision === "delegate") {
    try {
      await service.addLabels(issue.repo, issue.number, [ISSUE_TRIAGE_AUTO_FIX_LABEL]);
    } catch {
      return { ok: false, httpStatus: 502, error: "GitHub label API failed" };
    }
    return { ok: true, status: "labeled", decision };
  }

  let commentCreated = false;
  try {
    const hasExisting =
      (await service.hasExistingTriageComment?.(issue.repo, issue.number)) === true;
    if (!hasExisting) {
      await service.createComment(
        issue.repo,
        issue.number,
        buildIssueTriageDeclineComment(issue, classification),
      );
      commentCreated = true;
    }
  } catch {
    return { ok: false, httpStatus: 502, error: "GitHub comment API failed" };
  }

  try {
    await service.addLabels(issue.repo, issue.number, [ISSUE_TRIAGE_DECLINED_LABEL]);
  } catch {
    return { ok: false, httpStatus: 502, error: "GitHub label API failed" };
  }
  return { ok: true, status: "labeled", decision, commentCreated };
}
