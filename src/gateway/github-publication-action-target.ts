import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionGitHubPublicationPublished,
  SessionGitHubPullRequestInspectResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";

type SessionRead = Awaited<ReturnType<typeof prepareGitHubPublicationSession>>;

/** Keep every selected parent alive; a reparented child cannot redirect a retained action. */
export async function preparePublishingSession(
  params: { sessionKey: string; agentId?: string; publishingSessionKey?: string },
  assertCurrent: () => void,
  resources: DisposableStack,
) {
  const source = resources.use(
    await prepareGitHubPublicationSession(params.sessionKey, {
      agentId: params.agentId,
      assertCurrent,
    }),
  );
  const selected =
    params.publishingSessionKey && params.publishingSessionKey !== source.loaded.canonicalKey
      ? resources.use(
          await prepareGitHubPublicationSession(params.publishingSessionKey, { assertCurrent }),
        )
      : source;
  const readers: SessionRead[] = [source, selected];
  const assertSessions = () => {
    assertCurrent();
    for (const reader of readers) {
      if (!reader.readCurrent().entry?.sessionId) {
        throw new Error("The GitHub publication session is unavailable.");
      }
    }
  };
  let key = selected.loaded.canonicalKey;
  let agentId = selected.loaded.agentId;
  const seen = new Set<string>();
  while (key !== source.loaded.canonicalKey || agentId !== source.loaded.agentId) {
    const identity = `${agentId}\0${key}`;
    if (seen.has(identity) || seen.size >= 64) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    seen.add(identity);
    const lineage = resources.use(
      await prepareGitHubPublicationSession(key, {
        agentId: parseAgentSessionKey(key) ? undefined : agentId,
        assertCurrent,
        fields: ["sessionId", "lifecycleRevision", "parentSessionKey", "spawnedBy"],
      }),
    );
    readers.push(lineage);
    assertSessions();
    agentId = lineage.loaded.agentId;
    if (
      lineage.loaded.canonicalKey === source.loaded.canonicalKey &&
      agentId === source.loaded.agentId
    ) {
      break;
    }
    const entry = lineage.readCurrent().entry;
    const parent = entry?.parentSessionKey ?? entry?.spawnedBy;
    if (!parent) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    key = parent;
  }
  assertSessions();
  return { selected, assertCurrent: assertSessions };
}

export function pullRequestState(
  value: unknown,
  publication: Pick<SessionGitHubPublicationPublished, "url" | "repository" | "branch">,
  binding?: Pick<SessionGitHubPullRequestInspectResult, "number" | "base" | "head">,
  authorAccountId?: number,
) {
  if (
    !isRecord(value) ||
    !isRecord(value.head) ||
    !isRecord(value.base) ||
    !isRecord(value.base.repo) ||
    typeof value.node_id !== "string" ||
    !value.node_id ||
    value.html_url !== publication.url ||
    value.head.ref !== publication.branch ||
    typeof value.base.repo.full_name !== "string" ||
    value.base.repo.full_name.toLowerCase() !== publication.repository.toLowerCase() ||
    typeof value.head.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.head.sha) ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    typeof value.merged !== "boolean" ||
    (value.mergeable !== null && typeof value.mergeable !== "boolean") ||
    typeof value.mergeable_state !== "string" ||
    typeof value.title !== "string" ||
    (value.body !== null && typeof value.body !== "string") ||
    (value.merge_commit_sha !== null && typeof value.merge_commit_sha !== "string")
  ) {
    throw new Error(
      "GitHub returned an invalid pull request state; inspect the published PR before retrying.",
    );
  }
  if (
    binding &&
    (value.number !== binding.number ||
      value.base.repo.id !== binding.base.repositoryId ||
      value.base.ref !== binding.base.branch ||
      (binding.head
        ? !isRecord(value.head.repo) ||
          value.head.repo.id !== binding.head.repositoryId ||
          value.head.repo.full_name !== binding.head.repository
        : value.head.repo !== null) ||
      (authorAccountId !== undefined &&
        (!isRecord(value.user) || value.user.id !== authorAccountId)))
  ) {
    throw new Error(
      "The original PR target or author changed; inspect it again before continuing.",
    );
  }
  return {
    nodeId: value.node_id,
    state: value.merged
      ? ("merged" as const)
      : value.state === "closed"
        ? ("closed" as const)
        : value.draft
          ? ("draft" as const)
          : ("open" as const),
    headCommit: value.head.sha,
    // Open PRs can expose a synthetic test-merge SHA, not a landed commit.
    mergeCommit: value.merged ? value.merge_commit_sha : null,
    mergeable: value.mergeable,
    mergeState: value.mergeable_state,
    title: value.title,
    body: value.body ?? "",
  };
}
