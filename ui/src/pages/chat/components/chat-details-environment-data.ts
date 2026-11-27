import { showsChatMachineMenu } from "../chat-pane-placement.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { retainedPublication, showWorkRow } from "./chat-pull-requests.ts";

export function hasEnvironmentTextChanges(result?: { additions?: number; deletions?: number }) {
  return (result?.additions ?? 0) > 0 || (result?.deletions ?? 0) > 0;
}

export function detailsEnvironmentWorkInput(chat: ChatDetailsProps) {
  return {
    branch: chat.pullRequestsBranch,
    branchDismissed: chat.pullRequestsBranchDismissed,
    publication: chat.githubPublication,
    pullRequests: chat.pullRequests ?? [],
  };
}

export function detailsEnvironmentWork<
  Work extends Pick<
    ChatPullRequestsProps,
    "branch" | "branchDismissed" | "publication" | "pullRequests"
  >,
>(candidate: Work | undefined): Work | undefined {
  const publication = candidate?.publication;
  // A live PR replaces the branch unless an unresolved publication still needs attention.
  if (
    !candidate ||
    publication?.result?.status === "published" ||
    (!candidate.branch &&
      !publication?.locked &&
      candidate.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft"))
  ) {
    return undefined;
  }
  return showWorkRow(candidate) || retainedPublication(publication) ? candidate : undefined;
}

export function detailsEnvironmentLive(chat: ChatDetailsProps, workBranch: string | undefined) {
  return {
    branch: chat.detailsWorkspace?.branch ?? workBranch,
    worktree: Boolean(chat.selectedSession?.worktree),
  };
}

export function detailsEnvironmentChanges(
  result: NonNullable<ChatDetailsProps["environment"]>["uncommitted"],
) {
  return result && !result.unavailableReason && hasEnvironmentTextChanges(result)
    ? result
    : undefined;
}

export function hasDesktopEnvironment(chat: ChatDetailsProps) {
  const placement = chat.environment?.placement;
  const session = placement?.session ?? chat.selectedSession;
  const state = session?.placement?.state;
  const work = detailsEnvironmentWork(detailsEnvironmentWorkInput(chat));
  const facts =
    (!chat.sessionFactsReady && chat.cachedDetails?.environment) ||
    detailsEnvironmentLive(chat, work?.branch?.branch);
  return Boolean(
    (showsChatMachineMenu(session) &&
      (placement ||
        (state !== "local" && state !== "requested" && session?.placement?.environmentId))) ||
    facts.branch ||
    facts.worktree ||
    work ||
    detailsEnvironmentChanges(chat.environment?.uncommitted),
  );
}
