import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { publicationPullRequest } from "./chat-pull-requests.ts";

/** Other surfaces drop the publication once a mobile pill, or the PR pill continuing it, owns it. */
export function publicationOutsidePills(
  pills: ChatActivityPillsProps | undefined,
  publication: GitHubPublicationView | undefined,
): GitHubPublicationView | undefined {
  return pills?.publication ||
    (pills?.pullRequests && publicationPullRequest(publication, pills.pullRequests.items))
    ? undefined
    : publication;
}

export function hasVisibleChatActivityPills(props: ChatActivityPillsProps): boolean {
  return (
    Boolean(props.goal) ||
    (!props.approvalPending &&
      Boolean(
        props.subagents?.activities.some(
          (agent) => agent.status === "running" || agent.status === "waiting",
        ) ||
        props.progress ||
        props.pullRequests?.items.length ||
        props.publication,
      ))
  );
}
