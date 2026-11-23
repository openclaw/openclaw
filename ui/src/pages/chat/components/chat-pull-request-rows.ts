import { formatGitHubItemReference } from "../../../components/github-link-target.ts";
import {
  orderSessionPullRequests,
  type SessionDisplayPullRequest,
} from "../../../lib/session-pull-request-presentation.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";

export type PullRequestRowEntry = {
  url: string;
  branch: string;
  reference: string;
  request?: SessionDisplayPullRequest;
};

export function chatPullRequestRows(
  props: Pick<ChatPullRequestsProps, "pullRequests" | "publishedOnly" | "publication">,
): PullRequestRowEntry[] {
  const rows: PullRequestRowEntry[] = orderSessionPullRequests(props.pullRequests).map(
    (request) => ({
      url: request.url,
      branch: request.branch,
      reference: formatGitHubItemReference(request),
      request,
    }),
  );
  const receipt =
    props.publication?.result?.status === "published" ? props.publication.result : undefined;
  if (props.publishedOnly && receipt && !rows.some((row) => row.url === receipt.url)) {
    rows.push({ url: receipt.url, branch: receipt.branch, reference: receipt.repository });
  }
  return rows;
}
