import type { GitLabIssueOperation } from "@openclaw/gateway-protocol/gitlab-issues";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeGitLabIssuer } from "../agents/gitlab-host.js";
import type { PersonalGitLabCredential } from "./gitlab-personal-oauth.js";

export const GITLAB_ISSUE_PAGE_SIZE = 50;

export type Project = { id: number; path: string; webUrl: string };
export type Actor = { accountId: number; login: string; issuer: string };
export type Issue = {
  id: number;
  iid: number;
  webUrl: string;
  title: string;
  description: string;
  state: "opened" | "closed";
  updatedAt: string;
  authorId: number;
  labels: string[];
  assigneeIds: number[];
  milestoneId: number | null;
  dueDate: string | null;
};
export type Note = {
  id: number;
  body: string;
  authorId: number;
  createdAt: string;
  updatedAt: string;
  system: boolean;
};
export type Discussion = { id: string; resolved: boolean | null; notes: Note[] };
export type MergeRequest = {
  id: number;
  iid: number;
  webUrl: string;
  sha: string | null;
  state: string;
  diffRefs: { baseSha: string; startSha: string; headSha: string } | null;
};
export type IssueLink = {
  linkId: number | null;
  sourceIssueId: number;
  sourceIid: number;
  targetIssueId: number;
  targetProjectId: number;
  targetIid: number;
  targetWebUrl: string;
  targetTitle: string;
  targetState: "opened" | "closed";
  relation: "relates_to" | "blocks" | "is_blocked_by";
};
export type IssueTimeStats = {
  issueId: number;
  iid: number;
  timeEstimateSeconds: number;
  totalTimeSpentSeconds: number;
  humanTimeEstimate: string | null;
  humanTotalTimeSpent: string | null;
};

function positiveId(value: unknown, surface: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`GitLab ${surface} response is invalid.`);
  }
  return value;
}

function string(value: unknown, surface: string, maxLength = 65_536): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`GitLab ${surface} response is invalid.`);
  }
  return value;
}

export function projectUrlParts(raw: string, credential: PersonalGitLabCredential) {
  const issuer = normalizeGitLabIssuer(credential.account.issuer);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GitLab project URL must be a canonical HTTPS project root.");
  }
  const segments = url.pathname.slice(1).split("/");
  if (
    raw.length > 2048 ||
    url.origin !== issuer ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== raw ||
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9_.-]{1,255}$/u.test(segment) ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".git"),
    )
  ) {
    throw new Error("GitLab project URL must be a canonical project on the connected issuer.");
  }
  return { issuer, path: segments.join("/"), webUrl: raw };
}

export function parseProject(value: unknown, target: ReturnType<typeof projectUrlParts>): Project {
  if (
    !isRecord(value) ||
    value.path_with_namespace !== target.path ||
    value.web_url !== target.webUrl
  ) {
    throw new Error("GitLab project identity changed or was not found.");
  }
  return { id: positiveId(value.id, "project"), path: target.path, webUrl: target.webUrl };
}

export function parseProjectById(
  value: unknown,
  id: number,
  credential: PersonalGitLabCredential,
): Project {
  if (!isRecord(value) || typeof value.web_url !== "string") {
    throw new Error("GitLab linked project response is invalid.");
  }
  const project = parseProject(value, projectUrlParts(value.web_url, credential));
  if (project.id !== id) {
    throw new Error("GitLab linked project identity changed.");
  }
  return project;
}

function linkRelation(value: unknown): IssueLink["relation"] {
  if (value !== "relates_to" && value !== "blocks" && value !== "is_blocked_by") {
    throw new Error("GitLab issue link relation is invalid.");
  }
  return value;
}

export function linkedIssueProjectId(value: unknown): number {
  if (!isRecord(value)) {
    throw new Error("GitLab linked issue response is invalid.");
  }
  return positiveId(value.project_id, "linked issue project");
}

// GitLab may return either the issue route or its native work-item route.
// Both must identify this exact project and IID; never accept an arbitrary URL.
function issueWebUrl(value: unknown, project: Project, iid: number): string {
  for (const route of ["issues", "work_items"]) {
    const expected = new URL(`-/${route}/${iid}`, `${project.webUrl}/`).toString();
    if (value === expected) {
      return expected;
    }
  }
  throw new Error("GitLab issue URL changed or response is invalid.");
}

export function parseListedIssueLink(
  value: unknown,
  source: Issue,
  linkedProject: Project,
): IssueLink {
  if (!isRecord(value) || value.project_id !== linkedProject.id) {
    throw new Error("GitLab issue link target changed.");
  }
  const targetIid = positiveId(value.iid, "linked issue");
  const targetWebUrl = issueWebUrl(value.web_url, linkedProject, targetIid);
  if (value.state !== "opened" && value.state !== "closed") {
    throw new Error("GitLab issue link URL changed.");
  }
  return {
    linkId:
      value.issue_link_id === undefined || value.issue_link_id === null
        ? null
        : positiveId(value.issue_link_id, "issue link"),
    sourceIssueId: source.id,
    sourceIid: source.iid,
    targetIssueId: positiveId(value.id, "linked issue"),
    targetProjectId: linkedProject.id,
    targetIid,
    targetWebUrl,
    targetTitle: string(value.title, "linked issue title", 255),
    targetState: value.state,
    relation: linkRelation(value.link_type),
  };
}

export function parseCreatedIssueLink(
  value: unknown,
  source: Issue,
  sourceProject: Project,
  target: Issue,
  relation: IssueLink["relation"],
  targetProject: Project,
): IssueLink {
  if (!isRecord(value) || !isRecord(value.source_issue) || !isRecord(value.target_issue)) {
    throw new Error("GitLab issue link response is invalid.");
  }
  if (
    value.source_issue.id !== source.id ||
    value.source_issue.iid !== source.iid ||
    value.source_issue.project_id !== sourceProject.id ||
    value.target_issue.id !== target.id ||
    value.target_issue.iid !== target.iid ||
    value.target_issue.project_id !== targetProject.id ||
    value.link_type !== relation
  ) {
    throw new Error("GitLab issue link target or relation changed.");
  }
  return {
    linkId: value.id === undefined || value.id === null ? null : positiveId(value.id, "issue link"),
    sourceIssueId: source.id,
    sourceIid: source.iid,
    targetIssueId: target.id,
    targetProjectId: targetProject.id,
    targetIid: target.iid,
    targetWebUrl: target.webUrl,
    targetTitle: target.title,
    targetState: target.state,
    relation,
  };
}

export function parseIssueTimeStats(value: unknown, issue: Issue): IssueTimeStats {
  if (!isRecord(value)) {
    throw new Error("GitLab issue time response is invalid.");
  }
  const number = (entry: unknown): number => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error("GitLab issue time response is invalid.");
    }
    return entry;
  };
  const human = (entry: unknown): string | null =>
    entry === null ? null : string(entry, "issue time", 64);
  return {
    issueId: issue.id,
    iid: issue.iid,
    timeEstimateSeconds: number(value.time_estimate),
    totalTimeSpentSeconds: number(value.total_time_spent),
    humanTimeEstimate: human(value.human_time_estimate),
    humanTotalTimeSpent: human(value.human_total_time_spent),
  };
}

export function parseIssue(value: unknown, project: Project): Issue {
  if (!isRecord(value) || !isRecord(value.author) || !Array.isArray(value.labels)) {
    throw new Error("GitLab issue response is invalid.");
  }
  const iid = positiveId(value.iid, "issue");
  const webUrl = issueWebUrl(value.web_url, project, iid);
  if (
    value.project_id !== project.id ||
    (value.state !== "opened" && value.state !== "closed") ||
    value.labels.some((label) => typeof label !== "string") ||
    !Array.isArray(value.assignees) ||
    value.assignees.some((assignee) => !isRecord(assignee) || !Number.isSafeInteger(assignee.id))
  ) {
    throw new Error("GitLab issue target changed or response is invalid.");
  }
  const milestone = value.milestone;
  return {
    id: positiveId(value.id, "issue"),
    iid,
    webUrl,
    title: string(value.title, "issue", 255),
    description: value.description === null ? "" : string(value.description, "issue"),
    state: value.state,
    updatedAt: string(value.updated_at, "issue", 64),
    authorId: positiveId(value.author.id, "issue author"),
    // SAFETY: The response guard above rejects every non-string label.
    labels: value.labels as string[],
    assigneeIds: value.assignees.map((assignee) =>
      // SAFETY: The response guard above proves each assignee is a record with an integer id.
      positiveId((assignee as Record<string, unknown>).id, "assignee"),
    ),
    milestoneId:
      milestone === null
        ? null
        : isRecord(milestone)
          ? positiveId(milestone.id, "milestone")
          : null,
    dueDate:
      value.due_date === null || value.due_date === undefined
        ? null
        : string(value.due_date, "due date", 10),
  };
}

export function parseNote(value: unknown): Note {
  if (!isRecord(value) || !isRecord(value.author) || typeof value.system !== "boolean") {
    throw new Error("GitLab note response is invalid.");
  }
  return {
    id: positiveId(value.id, "note"),
    body: string(value.body, "note"),
    authorId: positiveId(value.author.id, "note author"),
    createdAt: string(value.created_at, "note", 64),
    updatedAt: string(value.updated_at, "note", 64),
    system: value.system,
  };
}

export function parseDiscussion(value: unknown): Discussion {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{8,128}$/u.test(value.id) ||
    !Array.isArray(value.notes) ||
    value.notes.length < 1 ||
    value.notes.length > 100
  ) {
    throw new Error("GitLab discussion response is invalid.");
  }
  const notes = value.notes.map(parseNote);
  const first = value.notes[0];
  const resolved = isRecord(first) && typeof first.resolved === "boolean" ? first.resolved : null;
  return { id: value.id, resolved, notes };
}

export function parseMergeRequest(value: unknown, project: Project): MergeRequest {
  if (!isRecord(value) || value.project_id !== project.id) {
    throw new Error("GitLab merge request response is invalid.");
  }
  const iid = positiveId(value.iid, "merge request");
  const webUrl = new URL(`-/merge_requests/${iid}`, `${project.webUrl}/`).toString();
  if (value.web_url !== webUrl) {
    throw new Error("GitLab merge request target changed.");
  }
  const refs = value.diff_refs;
  const diffRefs = isRecord(refs)
    ? {
        baseSha: string(refs.base_sha, "merge request SHA", 40),
        startSha: string(refs.start_sha, "merge request SHA", 40),
        headSha: string(refs.head_sha, "merge request SHA", 40),
      }
    : null;
  return {
    id: positiveId(value.id, "merge request"),
    iid,
    webUrl,
    sha: value.sha === null ? null : string(value.sha, "merge request SHA", 40),
    state: string(value.state, "merge request state", 32),
    diffRefs,
  };
}

export function collection(value: unknown, surface: string): unknown[] {
  if (!Array.isArray(value) || value.length > GITLAB_ISSUE_PAGE_SIZE) {
    throw new Error(`GitLab ${surface} page is invalid.`);
  }
  return value;
}

export const issueMutationBody = (
  input: Extract<GitLabIssueOperation, { action: "issue.create" | "issue.update" }>,
) => {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) {
    body.title = input.title;
  }
  if (input.description !== undefined) {
    body.description = input.description;
  }
  if ("labels" in input && input.labels !== undefined) {
    body.labels = input.labels.join(",");
  }
  if ("addLabels" in input && input.addLabels !== undefined) {
    body.add_labels = input.addLabels.join(",");
  }
  if ("removeLabels" in input && input.removeLabels !== undefined) {
    body.remove_labels = input.removeLabels.join(",");
  }
  if (input.assigneeIds !== undefined) {
    body.assignee_ids = input.assigneeIds;
  }
  if (input.milestoneId !== undefined) {
    body.milestone_id = input.milestoneId ?? 0;
  }
  if (input.dueDate !== undefined) {
    body.due_date = input.dueDate;
  }
  return body;
};

export type ProjectMetadata =
  | { id: number; username: string; name: string }
  | { id: number; name: string; description: string }
  | { id: number; title: string; state: string };

export function parseProjectMetadata(
  value: unknown,
  action: "project.members" | "project.labels" | "project.milestones",
): ProjectMetadata {
  if (!isRecord(value)) {
    throw new Error("GitLab project metadata response is invalid.");
  }
  const id = positiveId(value.id, "project metadata");
  if (action === "project.members") {
    return {
      id,
      username: string(value.username, "member", 255),
      name: string(value.name, "member", 255),
    };
  }
  if (action === "project.labels") {
    return {
      id,
      name: string(value.name, "label", 255),
      description: value.description === null ? "" : string(value.description, "label"),
    };
  }
  return {
    id,
    title: string(value.title, "milestone", 255),
    state: string(value.state, "milestone", 64),
  };
}
