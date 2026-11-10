import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GitHubPublicationReadUnavailableError } from "./github-publication-json-read.js";
import type { prepareSelectedGitHubPullRequestReader } from "./github-publication-selected-read.js";
export const unavailable = () =>
  new GitHubPublicationReadUnavailableError(
    "Auto-fix could not read current GitHub feedback; inspect repository access and retry.",
  );
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceNames = ["checks", "comments", "reviews", "reviewThreads"] as const;
type Finding = {
  id: string;
  revision: string;
  threadId?: string;
  author: string;
  body: string;
  truncated: boolean;
};
type Scan = {
  head: string;
  source: number;
  cursor: string | null;
  digest: string;
  count: number;
  findings: Finding[];
  checkDigest: string;
  failures: number;
  apps: string[];
  thread?: { id: string; resolved: boolean; next: string | null; cursor: string | null };
};
function connection(value: unknown) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isRecord) ||
    !isRecord(value.pageInfo) ||
    typeof value.pageInfo.hasNextPage !== "boolean" ||
    (value.pageInfo.hasNextPage && typeof value.pageInfo.endCursor !== "string")
  ) {
    throw unavailable();
  }
  return {
    nodes: value.nodes,
    next: value.pageInfo.hasNextPage ? String(value.pageInfo.endCursor) : null,
  };
}
const commentFields =
  "id body updatedAt authorAssociation author { login __typename ... on Bot { databaseId } ... on User { databaseId } }";
const pageInfo = "pageInfo { hasNextPage endCursor }";
// gh projects each body before the native transport's stdout cap. updatedAt and id
// identify edits even outside the preview. The model must read full finding text.
const compactFeedback =
  ".data.repository.pullRequest |= (if .comments then .comments.nodes |= map(. + {bodyTruncated: ((.body | length) > 2048)} | .body = .body[0:2048]) elif .reviews then .reviews.nodes |= map(. + {bodyTruncated: ((.body | length) > 2048)} | .body = .body[0:2048]) else . end) | if .data.node.comments then .data.node.comments.nodes |= map(. + {bodyTruncated: ((.body | length) > 2048)} | .body = .body[0:2048]) else . end";
function feedback(
  value: Record<string, unknown>,
  apps: readonly string[],
  producerId?: number,
  humanAuthorId?: number,
): Finding | undefined {
  if (
    !isRecord(value.author) ||
    typeof value.author.login !== "string" ||
    typeof value.id !== "string" ||
    typeof value.body !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw unavailable();
  }
  // Do not suppress a human PR author (including a bound contributor's request).
  // Only a verified bot producer's own output is suppressed; bot spelling grants nothing.
  if (
    producerId !== undefined &&
    value.author.__typename === "Bot" &&
    value.author.databaseId === producerId
  ) {
    return undefined;
  }
  const associated = ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(value.authorAssociation));
  const selectedHuman =
    humanAuthorId !== undefined &&
    value.author.__typename === "User" &&
    value.author.databaseId === humanAuthorId;
  // An App check on this repository/head is native evidence of an eligible integration.
  // GitHub owns Bot identities and App slugs; a user spelling or a public App listing is not enough.
  const integration =
    value.author.__typename === "Bot" &&
    Number.isSafeInteger(value.author.databaseId) &&
    apps.includes(value.author.login);
  if (!associated && !integration && !selectedHuman) {
    return undefined;
  }
  if (!value.body.trim() || value.state === "APPROVED" || value.state === "DISMISSED") {
    return undefined;
  }
  return {
    id: value.id,
    revision: fingerprint([value.id, value.updatedAt]),
    author: value.author.login,
    body: value.body.slice(0, 2048),
    truncated: value.bodyTruncated === true,
  };
}

/** Advance only this recipe's bounded inventory, then re-read current candidates and exact-head checks. */
export async function readPrAutoFixFeedback(params: {
  previous?: Record<string, unknown>;
  head: string;
  owner: string;
  repo: string;
  number: number;
  reader: Pick<Awaited<ReturnType<typeof prepareSelectedGitHubPullRequestReader>>, "readJson">;
  pullRequest: { repository: string };
  producerId?: number;
  humanAuthorId?: number;
  retryable: boolean;
  attemptedFindings: Record<string, unknown>[];
  dispositions: Record<string, unknown>[];
  quietFindings: Record<string, unknown>[];
}) {
  const {
    previous,
    head,
    owner,
    repo,
    number,
    reader,
    pullRequest,
    producerId,
    humanAuthorId,
    retryable,
    attemptedFindings,
    dispositions,
    quietFindings,
  } = params;
  const scan: Scan =
    previous?.version === 3 && isRecord(previous.scan) && previous.scan.head === head
      ? (structuredClone(previous.scan) as Scan)
      : {
          head,
          source: 0,
          cursor: null,
          digest: fingerprint([]),
          count: 0,
          findings: [],
          checkDigest: fingerprint([]),
          failures: 0,
          apps: [],
        };
  const reopenedFindings = new Set<string>();
  const addFeedback = (
    value: Record<string, unknown>,
    threadId?: string,
    threadResolved = false,
  ) => {
    const finding = feedback(value, scan.apps, producerId, humanAuthorId);
    if (!finding) {
      return;
    }
    if (threadId) {
      finding.threadId = threadId;
    }
    if (threadId) {
      const addressed = dispositions.findIndex(
        (d) =>
          d.revision === finding.revision && d.threadId === threadId && d.status === "addressed",
      );
      const receipt = dispositions[addressed];
      // Addressed can be publication/path/CI-backed while still unresolved.
      // Only an actually observed resolved -> unresolved transition reopens it.
      if (receipt?.threadResolved === true && !threadResolved) {
        dispositions.splice(addressed, 1);
        const quiet = quietFindings.findIndex((f) => f.revision === finding.revision);
        if (quiet >= 0) {
          quietFindings.splice(quiet, 1);
        }
        reopenedFindings.add(finding.id);
      } else if (receipt) {
        receipt.threadResolved = threadResolved;
      }
    }
    if (dispositions.some((d) => d.revision === finding.revision)) {
      return;
    }
    if (threadResolved) {
      return;
    }
    scan.digest = fingerprint([scan.digest, finding.revision]);
    scan.count++;
    // A ready batch is at most one three-item connection page. Successful
    // unresolved items stay quiet, but remain explicitly unresolved.
    if (!quietFindings.some((f) => f.revision === finding.revision)) {
      scan.findings.push(finding);
    }
  };
  // Each occurrence makes bounded cursor progress, including nested thread
  // comments. Never fetch 100 x 100 bodies or discard an overflow page.
  const scanDeadline = Date.now() + 10_000;
  for (
    let reads = 0;
    reads < 32 && Date.now() < scanDeadline && scan.source < sourceNames.length;
    reads++
  ) {
    const source = sourceNames[scan.source]!;
    let selection: string;
    if (source === "checks") {
      selection =
        "commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 10, after: $cursor) { " +
        pageInfo +
        " nodes { ... on CheckRun { __typename id name status conclusion completedAt checkSuite { app { slug } repository { nameWithOwner } } } ... on StatusContext { __typename id context state createdAt } } } } } } }";
    } else if (source === "reviewThreads") {
      selection =
        "reviewThreads(first: 1, after: $cursor) { " + pageInfo + " nodes { id isResolved } }";
    } else {
      selection =
        source +
        "(first: 3, after: $cursor) { " +
        pageInfo +
        " nodes { " +
        commentFields +
        (source === "reviews" ? " state" : "") +
        " } }";
    }
    // One thread at a time retains its remaining page and outer cursor.
    const query = scan.thread
      ? "query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequestReviewThread { id isResolved comments(first: 3, after: $cursor) { " +
        pageInfo +
        " nodes { " +
        commentFields +
        " } } } } }"
      : "query($owner: String!, $repo: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid " +
        selection +
        " } } }";
    const response = await reader.readJson("graphql", {
      query,
      jq: compactFeedback,
      variables: scan.thread
        ? { id: scan.thread.id, cursor: scan.thread.cursor }
        : { owner, repo, number, cursor: scan.cursor },
    });
    if (!isRecord(response) || response.errors || !isRecord(response.data)) {
      throw unavailable();
    }
    if (scan.thread) {
      const thread = response.data.node;
      if (
        !isRecord(thread) ||
        thread.id !== scan.thread.id ||
        typeof thread.isResolved !== "boolean"
      ) {
        throw unavailable();
      }
      const page = connection(thread.comments);
      for (const comment of page.nodes) {
        addFeedback(comment, scan.thread.id, thread.isResolved);
      }
      if (page.next) {
        scan.thread.cursor = page.next;
      } else {
        scan.cursor = scan.thread.next;
        delete scan.thread;
        if (!scan.cursor) {
          scan.source++;
        }
      }
      if (scan.findings.length) {
        break;
      }
      continue;
    }
    const repository = response.data.repository;
    if (!isRecord(repository) || !isRecord(repository.pullRequest)) {
      throw unavailable();
    }
    const pr = repository.pullRequest;
    if (pr.headRefOid !== head) {
      throw new GitHubPublicationReadUnavailableError(
        "Auto-fix PR head changed during its feedback scan; retry a fresh observation.",
      );
    }
    if (source === "checks") {
      const commit =
        isRecord(pr.commits) && Array.isArray(pr.commits.nodes) && isRecord(pr.commits.nodes[0])
          ? pr.commits.nodes[0].commit
          : undefined;
      if (!isRecord(commit) || commit.oid !== head) {
        throw unavailable();
      }
      if (commit.statusCheckRollup === null) {
        scan.source++;
        continue;
      }
      if (!isRecord(commit.statusCheckRollup)) {
        throw unavailable();
      }
      const page = connection(commit.statusCheckRollup.contexts);
      for (const check of page.nodes) {
        if (
          typeof check.id !== "string" ||
          !["CheckRun", "StatusContext"].includes(String(check.__typename))
        ) {
          throw unavailable();
        }
        if (
          isRecord(check.checkSuite) &&
          isRecord(check.checkSuite.app) &&
          isRecord(check.checkSuite.repository) &&
          check.checkSuite.repository.nameWithOwner === pullRequest.repository &&
          typeof check.checkSuite.app.slug === "string"
        ) {
          const login = check.checkSuite.app.slug + "[bot]";
          if (!scan.apps.includes(login)) {
            scan.apps.push(login);
          }
        }
        const failed =
          check.__typename === "CheckRun"
            ? check.status === "COMPLETED" &&
              [
                "FAILURE",
                "TIMED_OUT",
                "CANCELLED",
                "ACTION_REQUIRED",
                "STARTUP_FAILURE",
                "STALE",
              ].includes(String(check.conclusion))
            : ["ERROR", "FAILURE"].includes(String(check.state));
        if (failed) {
          scan.failures++;
          scan.checkDigest = fingerprint([scan.checkDigest, check]);
        }
      }
      scan.cursor = page.next;
    } else if (source === "reviewThreads") {
      // Read a single outer thread, then all its nested comments. The outer
      // query uses one node so no following thread can be skipped.
      const page = connection(pr.reviewThreads);
      const thread = page.nodes[0];
      if (thread) {
        if (typeof thread.id !== "string" || typeof thread.isResolved !== "boolean") {
          throw unavailable();
        }
        scan.thread = {
          id: thread.id,
          resolved: thread.isResolved,
          next: page.next,
          cursor: null,
        };
        continue;
      }
      scan.cursor = page.next;
    } else {
      const page = connection(pr[source]);
      for (const value of page.nodes) {
        addFeedback(value);
      }
      scan.cursor = page.next;
    }
    if (!scan.cursor) {
      scan.source++;
    }
    if (scan.findings.length) {
      break;
    }
  }
  const inventoryComplete = scan.source === sourceNames.length;
  // A bounded current batch need not wait for an entire large PR inventory.
  // Its native candidates are re-read below, never stitched into a fresh snapshot.
  const complete = inventoryComplete || scan.findings.length > 0 || scan.failures > 0 || retryable;
  // A cursor traversal is an inventory, not an atomic snapshot. Re-read the
  // bounded candidate/attempt items together with the exact-head CI facts.
  // An edit during an earlier page never qualifies a stale disposition.
  const ids = [
    ...new Set(
      [...scan.findings, ...attemptedFindings]
        .flatMap((f) => [f.id, f.threadId])
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  let freshNodes: Record<string, unknown>[] = [];
  let exactHeadChecks = false;
  if (complete) {
    const targetFields = "number repository { nameWithOwner }";
    const response = await reader.readJson("graphql", {
      query:
        "query($owner: String!, $repo: String!, $number: Int!, $ids: [ID!]!) { nodes(ids: $ids) { " +
        "... on IssueComment { " +
        commentFields +
        " pullRequest { " +
        targetFields +
        " } } " +
        "... on PullRequestReview { " +
        commentFields +
        " state pullRequest { " +
        targetFields +
        " } } " +
        "... on PullRequestReviewComment { " +
        commentFields +
        " pullRequest { " +
        targetFields +
        " } } " +
        "... on PullRequestReviewThread { id isResolved } } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage endCursor } totalCount nodes { ... on CheckRun { __typename id name status conclusion completedAt checkSuite { app { slug } repository { nameWithOwner } } } ... on StatusContext { __typename id context state createdAt } } } } } } } } } }",
      variables: { owner, repo, number, ids },
      jq: ".data.nodes |= map(if .body then . + {bodyTruncated: ((.body | length) > 2048)} | .body = .body[0:2048] else . end)",
    });
    if (
      !isRecord(response) ||
      response.errors ||
      !isRecord(response.data) ||
      !Array.isArray(response.data.nodes) ||
      !response.data.nodes.every((node) => node === null || isRecord(node)) ||
      !isRecord(response.data.repository) ||
      !isRecord(response.data.repository.pullRequest)
    ) {
      throw unavailable();
    }
    freshNodes = response.data.nodes.filter(isRecord);
    const pr = response.data.repository.pullRequest;
    if (pr.headRefOid !== head) {
      throw unavailable();
    }
    const commit =
      isRecord(pr.commits) && Array.isArray(pr.commits.nodes) && isRecord(pr.commits.nodes[0])
        ? pr.commits.nodes[0].commit
        : undefined;
    const checks = isRecord(commit) && commit.oid === head ? commit.statusCheckRollup : undefined;
    exactHeadChecks =
      isRecord(checks) &&
      checks.state === "SUCCESS" &&
      isRecord(checks.contexts) &&
      Number(checks.contexts.totalCount) > 0 &&
      isRecord(checks.contexts.pageInfo) &&
      checks.contexts.pageInfo.hasNextPage === false;
    const contexts =
      isRecord(checks) && isRecord(checks.contexts) ? connection(checks.contexts) : undefined;
    if (isRecord(checks) && !contexts) {
      throw unavailable();
    }
    // A partial current check page cannot clear old failures or prove success.
    if (!contexts?.next) {
      scan.failures = 0;
      scan.checkDigest = fingerprint([]);
      scan.apps = [];
      for (const check of contexts?.nodes ?? []) {
        if (
          isRecord(check.checkSuite) &&
          isRecord(check.checkSuite.app) &&
          isRecord(check.checkSuite.repository) &&
          check.checkSuite.repository.nameWithOwner === pullRequest.repository &&
          typeof check.checkSuite.app.slug === "string"
        ) {
          scan.apps.push(check.checkSuite.app.slug + "[bot]");
        }
        const failed =
          check.__typename === "CheckRun"
            ? check.status === "COMPLETED" &&
              [
                "FAILURE",
                "TIMED_OUT",
                "CANCELLED",
                "ACTION_REQUIRED",
                "STARTUP_FAILURE",
                "STALE",
              ].includes(String(check.conclusion))
            : ["ERROR", "FAILURE"].includes(String(check.state));
        if (failed) {
          scan.failures++;
          scan.checkDigest = fingerprint([scan.checkDigest, check]);
        }
      }
    }
    const candidates = [...scan.findings];
    if (retryable) {
      for (const item of attemptedFindings) {
        if (!candidates.some((f) => f.id === item.id)) {
          const current = freshNodes.find((node) => node.id === item.id);
          if (current) {
            const finding = feedback(current, scan.apps, producerId, humanAuthorId);
            if (finding) {
              candidates.push({
                ...finding,
                ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
              });
            }
          }
        }
      }
    }
    scan.findings = candidates.flatMap((item) => {
      const current = freshNodes.find((node) => node.id === item.id);
      const itemPr = current?.pullRequest ?? current?.issue;
      if (
        !current ||
        !isRecord(itemPr) ||
        itemPr.number !== number ||
        !isRecord(itemPr.repository) ||
        itemPr.repository.nameWithOwner !== pullRequest.repository
      ) {
        return [];
      }
      if (
        item.threadId &&
        freshNodes.some((node) => node.id === item.threadId && node.isResolved === true)
      ) {
        return [];
      }
      const finding = feedback(current, scan.apps, producerId, humanAuthorId);
      return finding ? [{ ...finding, ...(item.threadId ? { threadId: item.threadId } : {}) }] : [];
    });
  }

  return { scan, complete, inventoryComplete, freshNodes, exactHeadChecks, reopenedFindings };
}
