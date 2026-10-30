import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";

const DISMISSED_STORAGE_KEY = "openclaw.chat.dismissedPullRequests";
// Bounds localStorage growth: dismissals for the oldest sessions fall off
// once this many sessions have dismissed chips.
const DISMISSED_SESSION_LIMIT = 20;

export function chatPullRequestId(pullRequest: ControlUiSessionPullRequest): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`.toLowerCase();
}

// Shares the per-session dismissal store with PR ids; `@` keeps the namespaces apart.
// GitHub owner/repo names are case-insensitive, but Git branch names are not.
export function chatBranchId(branch: ControlUiSessionBranch): string {
  return `${branch.owner}/${branch.repo}`.toLowerCase() + `@${branch.branch}`;
}

export function retainedPublication(publication: GitHubPublicationView | undefined) {
  return (
    publication?.result ||
    publication?.locked ||
    (publication?.error && !publication.optionsUnavailable)
  );
}

export function showWorkRow(props: ChatPullRequestsProps): boolean {
  return Boolean(
    (!props.branchDismissed && props.branch) ||
    (!props.pullRequests.length &&
      (retainedPublication(props.publication) ||
        (!props.branchDismissed &&
          props.publication?.canPublishShared &&
          !props.publication.canPublishPersonal &&
          props.publication.options?.shared))),
  );
}

export function hasChatPullRequests(props: ChatPullRequestsProps): boolean {
  return (
    props.pullRequests.length > 0 ||
    (props.publishedOnly ? props.publication?.result?.status === "published" : showWorkRow(props))
  );
}

function readDismissedStore(storage: Storage): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DISMISSED_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) {
      return {};
    }
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((id): id is string => typeof id === "string");
      }
    }
    return store;
  } catch {
    return {};
  }
}

export function listDismissedChatPullRequests(sessionKey: string): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set();
  }
  return new Set(readDismissedStore(storage)[sessionKey] ?? []);
}

/** Records a PR (`chatPullRequestId`) or branch (`chatBranchId`) dismissal. */
export function dismissChatPullRequest(sessionKey: string, id: string): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set([id]);
  }
  const store = readDismissedStore(storage);
  const ids = new Set(store[sessionKey] ?? []);
  ids.add(id);
  delete store[sessionKey];
  store[sessionKey] = [...ids];
  const staleSessions = Object.keys(store).slice(0, -DISMISSED_SESSION_LIMIT);
  for (const staleKey of staleSessions) {
    delete store[staleKey];
  }
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or privacy-mode failures only cost re-showing dismissed chips.
  }
  return ids;
}
