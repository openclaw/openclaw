import type { GitLabIssueOperation } from "@openclaw/gateway-protocol/gitlab-issues";
import { normalizeGitLabIssuer } from "../agents/gitlab-host.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-response-body.js";
import {
  GITLAB_ISSUE_PAGE_SIZE as PAGE_SIZE,
  projectUrlParts,
  parseProject,
  parseIssue,
  parseNote,
  parseDiscussion,
  parseMergeRequest,
  parseProjectById,
  linkedIssueProjectId,
  parseListedIssueLink,
  parseCreatedIssueLink,
  parseIssueTimeStats,
  collection,
  issueMutationBody,
  parseProjectMetadata,
  type ProjectMetadata,
  type Project,
  type Actor,
  type Issue,
  type Note,
  type Discussion,
  type MergeRequest,
  type IssueLink,
  type IssueTimeStats,
} from "./gitlab-issues-provider.js";
import type { PersonalGitLabCredential } from "./gitlab-personal-oauth.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type GitLabIssueOperationResult = {
  action: GitLabIssueOperation["action"];
  project: Project;
  actor: Actor;
  item?: Issue | Note | Discussion | MergeRequest | IssueLink | IssueTimeStats;
  items?: (Issue | Note | Discussion | IssueLink | ProjectMetadata)[];
  nextPage?: number | null;
  truncated?: boolean;
  deletedNoteId?: number;
  effect?: { remoteId: number | string; authorId?: number; outcome: "observed" };
};

/** A write may have reached GitLab; callers must inspect the exact target before another write. */
export class GitLabIssueOutcomeUnknownError extends Error {
  constructor(
    readonly operationKind: GitLabIssueOperation["action"],
    readonly projectUrl: string,
    readonly iid: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `GitLab ${operationKind} outcome is unknown. Read and reconcile the exact target before retrying.`,
      options,
    );
    this.name = "GitLabIssueOutcomeUnknownError";
  }
}

class GitLabIssueProviderError extends Error {
  constructor(readonly status: number) {
    super(`GitLab issue API returned HTTP ${status}.`);
  }
}

type RequestMethod = "GET" | "POST" | "PUT" | "DELETE";
type RequestReply = { value: unknown; nextPage: number | null; truncated: boolean };

/** One token-bearing request; URL paths are built only from a pinned project ID and typed IDs. */
export async function executeGitLabIssueOperation(params: {
  operation: GitLabIssueOperation;
  credential: PersonalGitLabCredential;
  signal: AbortSignal;
  assertCurrent: () => void;
  assertProjectAllowed: (projectId: number) => void;
}): Promise<GitLabIssueOperationResult> {
  const { credential, operation } = params;
  const target = projectUrlParts(operation.projectUrl, credential);
  const linkTarget =
    operation.action === "issue.link.create"
      ? projectUrlParts(operation.targetProjectUrl, credential)
      : undefined;
  const actor: Actor = {
    accountId: credential.account.accountId,
    login: credential.account.login,
    issuer: target.issuer,
  };
  const assertIdentity = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    credential.assertCurrent();
    if (normalizeGitLabIssuer(credential.account.issuer) !== target.issuer) {
      throw new Error("GitLab account issuer changed.");
    }
  };
  let assertCurrent = assertIdentity;
  assertCurrent();
  const request = async (
    method: RequestMethod,
    path: string,
    body?: Record<string, unknown>,
    write = false,
  ): Promise<RequestReply> => {
    let dispatched = false;
    try {
      assertCurrent();
      return await credential.withToken(async (token) => {
        assertCurrent();
        const url = new URL(`/api/v4/${path}`, target.issuer);
        if (url.origin !== target.issuer || !url.pathname.startsWith("/api/v4/")) {
          throw new Error("GitLab issue API path escaped its issuer.");
        }
        const signal = AbortSignal.any([params.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        signal.throwIfAborted();
        if (write) {
          assertCurrent();
        }
        dispatched = true;
        const response = await fetch(url, {
          method,
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assertCurrent();
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          await cancelUnreadResponseBody(response);
          throw new Error("GitLab issue API redirected a credentialed request.");
        }
        if (!response.ok) {
          await cancelUnreadResponseBody(response);
          throw new GitLabIssueProviderError(response.status);
        }
        const bytes = await readResponseWithLimit(response, MAX_RESPONSE_BYTES, {
          timeoutMs: REQUEST_TIMEOUT_MS,
          chunkTimeoutMs: REQUEST_TIMEOUT_MS,
          signal,
        });
        assertCurrent();
        let value: unknown;
        try {
          value =
            bytes.length === 0 && response.status === 204
              ? null
              : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new Error("GitLab issue API returned invalid JSON.");
        }
        const next = response.headers.get("x-next-page");
        if (next && !/^[1-9]\d{0,8}$/u.test(next)) {
          throw new Error("GitLab pagination response is invalid.");
        }
        const page = Number(url.searchParams.get("page") ?? "1");
        const parsedNext = next
          ? Number(next)
          : next === null && Array.isArray(value) && value.length === PAGE_SIZE
            ? page + 1
            : null;
        if (parsedNext && parsedNext <= page) {
          throw new Error("GitLab pagination did not advance.");
        }
        return {
          value,
          nextPage: parsedNext && parsedNext <= 20 ? parsedNext : null,
          truncated: Boolean(parsedNext && parsedNext > 20),
        };
      });
    } catch (error) {
      if (
        write &&
        dispatched &&
        (!(error instanceof GitLabIssueProviderError) ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500)
      ) {
        throw new GitLabIssueOutcomeUnknownError(
          operation.action,
          operation.projectUrl,
          "iid" in operation ? operation.iid : undefined,
          { cause: error },
        );
      }
      throw error;
    }
  };
  const project = parseProject(
    (await request("GET", `projects/${encodeURIComponent(target.path)}`)).value,
    target,
  );
  const relatedProjectIds = new Set<number>();
  assertCurrent = () => {
    assertIdentity();
    params.assertProjectAllowed(project.id);
    for (const relatedId of relatedProjectIds) {
      params.assertProjectAllowed(relatedId);
    }
  };
  assertCurrent();
  const base = `projects/${project.id}`;
  const issuePath = (iid: number) => `${base}/issues/${iid}`;
  const resourcePath = (kind: "issue" | "merge_request", iid: number) =>
    `${base}/${kind === "issue" ? "issues" : "merge_requests"}/${iid}`;
  const result = (
    item: GitLabIssueOperationResult["item"],
    effect?: GitLabIssueOperationResult["effect"],
  ): GitLabIssueOperationResult => ({
    action: operation.action,
    project,
    actor,
    item,
    ...(effect ? { effect } : {}),
  });
  const pageResult = (
    items: GitLabIssueOperationResult["items"],
    reply: RequestReply,
  ): GitLabIssueOperationResult => ({
    action: operation.action,
    project,
    actor,
    items,
    nextPage: reply.nextPage,
    truncated: reply.truncated,
  });
  const observed = (remoteId: number | string, authorId?: number) => ({
    remoteId,
    ...(authorId ? { authorId } : {}),
    outcome: "observed" as const,
  });
  const writeObserved = async <T>(
    method: Exclude<RequestMethod, "GET">,
    path: string,
    body: Record<string, unknown> | undefined,
    parse: (value: unknown) => T,
  ): Promise<T> => {
    const reply = await request(method, path, body, true);
    try {
      return parse(reply.value);
    } catch (error) {
      if (error instanceof GitLabIssueOutcomeUnknownError) {
        throw error;
      }
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        "iid" in operation ? operation.iid : undefined,
        { cause: error },
      );
    }
  };
  const assertAuthor = (authorId: number) => {
    if (authorId !== actor.accountId) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        "iid" in operation ? operation.iid : undefined,
        { cause: new Error("GitLab effect author differed from the connected human.") },
      );
    }
  };
  const assertStoredBody = (note: Note, body: string) => {
    assertAuthor(note.authorId);
    // GitLab strips CR and trailing whitespace when persisting a note.
    if (note.body !== body.replace(/\r/gu, "").trimEnd()) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        "iid" in operation ? operation.iid : undefined,
      );
    }
  };
  const assertIssueFields = (
    issue: Issue,
    input: Extract<GitLabIssueOperation, { action: "issue.create" | "issue.update" }>,
  ) => {
    const sameIds = (a: number[], b: number[]) =>
      a.length === b.length && a.every((id) => b.includes(id));
    if (
      (input.title !== undefined && issue.title !== input.title) ||
      (input.description !== undefined &&
        issue.description !== input.description.replace(/\r/gu, "").trimEnd()) ||
      (input.assigneeIds !== undefined && !sameIds(input.assigneeIds, issue.assigneeIds)) ||
      (input.milestoneId !== undefined && issue.milestoneId !== input.milestoneId) ||
      (input.dueDate !== undefined && issue.dueDate !== input.dueDate) ||
      ("labels" in input &&
        input.labels !== undefined &&
        (input.labels.length !== issue.labels.length ||
          input.labels.some((label) => !issue.labels.includes(label)))) ||
      ("addLabels" in input && input.addLabels?.some((label) => !issue.labels.includes(label))) ||
      ("removeLabels" in input && input.removeLabels?.some((label) => issue.labels.includes(label)))
    ) {
      throw new GitLabIssueOutcomeUnknownError(operation.action, operation.projectUrl, issue.iid);
    }
  };
  const readIssue = async (iid: number) => {
    const issue = parseIssue((await request("GET", issuePath(iid))).value, project);
    if (issue.iid !== iid) {
      throw new Error("GitLab returned another issue.");
    }
    return issue;
  };
  const readIssueInProject = async (relatedProject: Project, iid: number) => {
    const issue = parseIssue(
      (await request("GET", `projects/${relatedProject.id}/issues/${iid}`)).value,
      relatedProject,
    );
    if (issue.iid !== iid) {
      throw new Error("GitLab returned another linked issue.");
    }
    return issue;
  };
  const relatedProjects = new Map<number, Project>([[project.id, project]]);
  const resolveRelatedProjectById = async (id: number): Promise<Project> => {
    params.assertProjectAllowed(id);
    relatedProjectIds.add(id);
    const existing = relatedProjects.get(id);
    if (existing) {
      return existing;
    }
    const resolved = parseProjectById(
      (await request("GET", `projects/${id}`)).value,
      id,
      credential,
    );
    relatedProjects.set(id, resolved);
    assertCurrent();
    return resolved;
  };
  const notePath = (
    kind: "issue" | "merge_request",
    iid: number,
    noteId: number,
    discussionId?: string,
  ) =>
    `${resourcePath(kind, iid)}${discussionId ? `/discussions/${discussionId}` : ""}/notes/${noteId}`;
  const readNote = async (
    kind: "issue" | "merge_request",
    iid: number,
    noteId: number,
    discussionId?: string,
  ) => {
    const note = discussionId
      ? (await readDiscussion(kind, iid, discussionId)).notes.find((entry) => entry.id === noteId)
      : parseNote((await request("GET", notePath(kind, iid, noteId))).value);
    if (!note) {
      throw new Error("GitLab discussion note was not found.");
    }
    if (note.id !== noteId) {
      throw new Error("GitLab returned another note.");
    }
    return note;
  };
  const readDiscussion = async (kind: "issue" | "merge_request", iid: number, id: string) => {
    const discussion = parseDiscussion(
      (await request("GET", `${resourcePath(kind, iid)}/discussions/${id}`)).value,
    );
    if (discussion.id !== id) {
      throw new Error("GitLab returned another discussion.");
    }
    return discussion;
  };
  const assertIssueVersion = async (iid: number, expectedUpdatedAt: string) => {
    const current = await readIssue(iid);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new Error("GitLab issue changed; read its current fields before updating.");
    }
    return current;
  };
  const assertNoteVersion = async (
    kind: "issue" | "merge_request",
    iid: number,
    noteId: number,
    expectedBody: string,
    discussionId?: string,
  ) => {
    const current = await readNote(kind, iid, noteId, discussionId);
    if (current.body !== expectedBody || current.authorId !== actor.accountId || current.system) {
      throw new Error("GitLab note changed or is not authored by this account.");
    }
  };
  if (
    operation.action === "project.members" ||
    operation.action === "project.labels" ||
    operation.action === "project.milestones"
  ) {
    const kind = operation.action;
    const endpoint =
      kind === "project.members"
        ? "members/all"
        : kind === "project.labels"
          ? "labels"
          : "milestones";
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      page: String(operation.page ?? 1),
    });
    if (operation.query) {
      query.set(kind === "project.members" ? "query" : "search", operation.query);
    }
    const reply = await request("GET", `${base}/${endpoint}?${query}`);
    return pageResult(
      collection(reply.value, "project metadata").map((entry) => parseProjectMetadata(entry, kind)),
      reply,
    );
  }
  if (operation.action === "issue.list") {
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      page: String(operation.page ?? 1),
      state: operation.state ?? "all",
    });
    if (operation.query) {
      query.set("search", operation.query);
    }
    const reply = await request("GET", `${base}/issues?${query}`);
    return pageResult(
      collection(reply.value, "issues").map((entry) => parseIssue(entry, project)),
      reply,
    );
  }
  if (operation.action === "issue.get") {
    return result(await readIssue(operation.iid));
  }
  if (operation.action === "issue.create") {
    const issue = await writeObserved(
      "POST",
      `${base}/issues`,
      issueMutationBody(operation),
      (value) => parseIssue(value, project),
    );
    assertAuthor(issue.authorId);
    assertIssueFields(issue, operation);
    return result(issue, observed(issue.id, issue.authorId));
  }
  if (operation.action === "issue.update") {
    await assertIssueVersion(operation.iid, operation.expectedUpdatedAt);
    const body = issueMutationBody(operation);
    if (Object.keys(body).length === 0) {
      throw new Error("GitLab issue update requires a changed field.");
    }
    const issue = await writeObserved("PUT", issuePath(operation.iid), body, (value) =>
      parseIssue(value, project),
    );
    if (issue.iid !== operation.iid) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        operation.iid,
      );
    }
    assertIssueFields(issue, operation);
    return result(issue, observed(issue.id));
  }
  if (operation.action === "issue.close" || operation.action === "issue.reopen") {
    const current = await assertIssueVersion(operation.iid, operation.expectedUpdatedAt);
    const state = operation.action === "issue.close" ? "closed" : "opened";
    if (current.state === state) {
      return result(current);
    }
    const issue = await writeObserved(
      "PUT",
      issuePath(operation.iid),
      { state_event: operation.action === "issue.close" ? "close" : "reopen" },
      (value) => parseIssue(value, project),
    );
    if (issue.iid !== operation.iid || issue.state !== state) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        operation.iid,
      );
    }
    return result(issue, observed(issue.id));
  }
  if (operation.action === "issue.link.list") {
    const source = await readIssue(operation.iid);
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      page: String(operation.page ?? 1),
    });
    const reply = await request("GET", `${issuePath(operation.iid)}/links?${query}`);
    const links: IssueLink[] = [];
    for (const linked of collection(reply.value, "issue links")) {
      const linkedProject = await resolveRelatedProjectById(linkedIssueProjectId(linked));
      links.push(parseListedIssueLink(linked, source, linkedProject));
    }
    assertCurrent();
    return pageResult(links, reply);
  }
  if (operation.action === "issue.link.create") {
    if (!linkTarget) {
      throw new Error("GitLab linked project target is missing.");
    }
    const source = await readIssue(operation.iid);
    const targetProject = parseProject(
      (await request("GET", `projects/${encodeURIComponent(linkTarget.path)}`)).value,
      linkTarget,
    );
    params.assertProjectAllowed(targetProject.id);
    relatedProjectIds.add(targetProject.id);
    assertCurrent();
    const linked = await readIssueInProject(targetProject, operation.targetIid);
    const link = await writeObserved(
      "POST",
      `${issuePath(operation.iid)}/links`,
      {
        target_project_id: targetProject.id,
        target_issue_iid: operation.targetIid,
        link_type: operation.relation,
      },
      (value) =>
        parseCreatedIssueLink(value, source, project, linked, operation.relation, targetProject),
    );
    return result(link, link.linkId === null ? undefined : observed(link.linkId));
  }
  if (operation.action === "issue.time.get" || operation.action === "issue.time.add") {
    const issue = await readIssue(operation.iid);
    const path = `${issuePath(operation.iid)}/time_stats`;
    const before = parseIssueTimeStats((await request("GET", path)).value, issue);
    if (operation.action === "issue.time.get") {
      return result(before);
    }
    const after = await writeObserved(
      "POST",
      `${issuePath(operation.iid)}/add_spent_time`,
      {
        duration: operation.duration,
        ...(operation.summary ? { summary: operation.summary } : {}),
      },
      (value) => parseIssueTimeStats(value, issue),
    );
    if (after.totalTimeSpentSeconds <= before.totalTimeSpentSeconds) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        operation.iid,
      );
    }
    // GitLab returns aggregate totals here, not an individual timelog ID.
    return result(after);
  }
  if (operation.action === "mr.get") {
    const mr = parseMergeRequest(
      (await request("GET", resourcePath("merge_request", operation.iid))).value,
      project,
    );
    if (mr.iid !== operation.iid) {
      throw new Error("GitLab returned another merge request.");
    }
    return result(mr);
  }
  if (operation.action === "note.list" || operation.action === "discussion.list") {
    const suffix = operation.action === "note.list" ? "notes" : "discussions";
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      page: String(operation.page ?? 1),
    });
    const reply = await request(
      "GET",
      `${resourcePath(operation.target, operation.iid)}/${suffix}?${query}`,
    );
    const values = collection(reply.value, suffix);
    const items =
      operation.action === "note.list" ? values.map(parseNote) : values.map(parseDiscussion);
    return pageResult(items, reply);
  }
  if (operation.action === "note.create") {
    const note = await writeObserved(
      "POST",
      `${resourcePath(operation.target, operation.iid)}/notes`,
      { body: operation.body },
      parseNote,
    );
    assertStoredBody(note, operation.body);
    return result(note, observed(note.id, note.authorId));
  }
  if (
    operation.action === "note.update" ||
    operation.action === "note.delete" ||
    operation.action === "discussion.note.update" ||
    operation.action === "discussion.note.delete"
  ) {
    const discussionId = "discussionId" in operation ? operation.discussionId : undefined;
    await assertNoteVersion(
      operation.target,
      operation.iid,
      operation.noteId,
      operation.expectedBody,
      discussionId,
    );
    const path = notePath(operation.target, operation.iid, operation.noteId, discussionId);
    if (operation.action === "note.delete" || operation.action === "discussion.note.delete") {
      await writeObserved("DELETE", path, undefined, (value) => {
        if (value !== null) {
          throw new Error("GitLab note deletion response is invalid.");
        }
      });
      return {
        action: operation.action,
        project,
        actor,
        deletedNoteId: operation.noteId,
        effect: observed(operation.noteId),
      };
    }
    const note = await writeObserved("PUT", path, { body: operation.body }, parseNote);
    assertStoredBody(note, operation.body);
    if (note.id !== operation.noteId || note.authorId !== actor.accountId) {
      throw new GitLabIssueOutcomeUnknownError(
        operation.action,
        operation.projectUrl,
        operation.iid,
      );
    }
    return result(note, observed(note.id, note.authorId));
  }
  if (operation.action === "discussion.create" || operation.action === "discussion.create_diff") {
    const body: Record<string, unknown> = { body: operation.body };
    if (operation.action === "discussion.create_diff") {
      const mr = parseMergeRequest(
        (await request("GET", resourcePath("merge_request", operation.iid))).value,
        project,
      );
      if (
        mr.iid !== operation.iid ||
        mr.sha !== operation.expectedHeadSha ||
        mr.diffRefs?.headSha !== operation.expectedHeadSha
      ) {
        throw new Error(
          "GitLab merge request head changed; inspect the current diff before commenting.",
        );
      }
      if (!operation.position.oldLine && !operation.position.newLine) {
        throw new Error("GitLab diff comment requires an observed line.");
      }
      body.position = {
        position_type: "text",
        base_sha: mr.diffRefs.baseSha,
        start_sha: mr.diffRefs.startSha,
        head_sha: mr.diffRefs.headSha,
        old_path: operation.position.oldPath,
        new_path: operation.position.newPath,
        ...(operation.position.oldLine ? { old_line: operation.position.oldLine } : {}),
        ...(operation.position.newLine ? { new_line: operation.position.newLine } : {}),
      };
    }
    const discussion = await writeObserved(
      "POST",
      `${resourcePath(operation.target, operation.iid)}/discussions`,
      body,
      parseDiscussion,
    );
    assertStoredBody(discussion.notes[0]!, operation.body);
    return result(discussion, observed(discussion.id, discussion.notes[0]!.authorId));
  }
  if (operation.action === "discussion.reply") {
    await readDiscussion(operation.target, operation.iid, operation.discussionId);
    const note = await writeObserved(
      "POST",
      `${resourcePath(operation.target, operation.iid)}/discussions/${operation.discussionId}/notes`,
      { body: operation.body },
      parseNote,
    );
    assertStoredBody(note, operation.body);
    return result(note, observed(note.id, note.authorId));
  }
  const discussion = await readDiscussion("merge_request", operation.iid, operation.discussionId);
  if (discussion.resolved !== operation.expectedResolved) {
    throw new Error("GitLab discussion state changed; inspect the thread before updating it.");
  }
  const resolved = operation.action === "discussion.resolve";
  const updated = await writeObserved(
    "PUT",
    `${resourcePath("merge_request", operation.iid)}/discussions/${operation.discussionId}`,
    { resolved },
    parseDiscussion,
  );
  if (updated.id !== operation.discussionId || updated.resolved !== resolved) {
    throw new GitLabIssueOutcomeUnknownError(operation.action, operation.projectUrl, operation.iid);
  }
  return result(updated, observed(updated.id));
}
