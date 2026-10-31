import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";

type PullRequestState = ControlUiSessionPullRequest["state"];
const STATE_ORDER: readonly PullRequestState[] = ["open", "draft", "merged", "closed"];

export const sessionPullRequestStateIcons = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;

/** All session surfaces put active work before merged/closed history. */
export function orderSessionPullRequests<T extends { state?: PullRequestState }>(
  requests: readonly T[],
): T[] {
  const rank = (state: PullRequestState | undefined) =>
    state === undefined ? 1.5 : STATE_ORDER.indexOf(state);
  return requests.toSorted((left, right) => rank(left.state) - rank(right.state));
}

export function primarySessionPullRequest(requests: readonly ControlUiSessionPullRequest[]) {
  for (const state of STATE_ORDER) {
    const request = requests.find((candidate) => candidate.state === state);
    if (request) {
      return request;
    }
  }
  return undefined;
}

export type SessionDisplayPullRequest = Omit<ControlUiSessionPullRequest, "state"> & {
  state?: ControlUiSessionPullRequest["state"];
  sourceSessionKey?: string;
  sourceAgentId?: string;
};

/** Presentation only: task results never become evidence that the current branch was published. */
export function displaySessionPullRequests(
  snapshot: ControlUiSessionPullRequestSnapshot | undefined,
): SessionDisplayPullRequest[] {
  const requests = new Map<string, SessionDisplayPullRequest>();
  for (const task of snapshot?.taskPullRequests ?? []) {
    requests.set(task.url, {
      owner: task.owner,
      repo: task.repo,
      number: task.number,
      branch: task.branch,
      url: task.url,
      title: task.title ?? `${task.owner}/${task.repo}#${task.number}`,
      ...task.pullRequest,
      sourceSessionKey: task.sourceSessionKey,
      sourceAgentId: task.sourceAgentId,
    });
  }
  for (const request of snapshot?.pullRequests ?? []) {
    requests.set(request.url, { ...requests.get(request.url), ...request });
  }
  return orderSessionPullRequests([...requests.values()]);
}
