import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";

type PullRequestState = ControlUiSessionPullRequest["state"];
const STATE_ORDER: readonly PullRequestState[] = ["open", "draft", "merged", "closed"];

export const sessionPullRequestStateIcons = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;

/** All session surfaces put active work before merged/closed history. */
export function orderSessionPullRequests(requests: readonly ControlUiSessionPullRequest[]) {
  return requests.toSorted(
    (left, right) => STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state),
  );
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
