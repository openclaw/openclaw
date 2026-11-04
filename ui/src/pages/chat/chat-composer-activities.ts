import { createMemo } from "solid-js";
import { orderSessionPullRequests } from "../../lib/session-pull-request-presentation.ts";
import { isChatRunWorking } from "./chat-run-working.ts";
import { listSubagents, projectProgressCardRuntime } from "./chat-subagent-wait.ts";
import type { ChatProps } from "./chat-view-frame.ts";
import type { ChatActivityPillsProps } from "./components/chat-activity-pills-types.ts";

/** Mobile composer activity pills: subagents, goal, progress, pull requests, publication. */
export function createChatComposerActivities(input: { props: ChatProps; presented: boolean }) {
  return createMemo((): ChatActivityPillsProps | undefined => {
    if (!input.props.mobileComposer) {
      return undefined;
    }
    const destinations = input.props.mobileActivities;
    const goal = input.props.selectedSession?.goal;
    const card = input.props.progressCard;
    return {
      presented: input.presented,
      approvalPending: Boolean(input.props.inlineApproval),
      subagents: destinations?.onOpenSubagents
        ? { activities: listSubagents(input.props), onOpen: destinations.onOpenSubagents }
        : undefined,
      goal:
        goal && destinations?.goal
          ? { ...destinations.goal, value: goal, recovery: input.props.goalRecovery }
          : undefined,
      // The pane's chat projection already applies the single Show in chat preference.
      progress:
        card && destinations?.onOpenProgress
          ? {
              card,
              sessionStatus: input.props.selectedSession?.status,
              startedAt: input.props.selectedSession?.startedAt,
              endedAt: input.props.selectedSession?.endedAt,
              hasActiveRun: isChatRunWorking(input.props),
              runtime: projectProgressCardRuntime(
                input.props.selectedSession,
                input.props,
                card.updatedAt,
                input.props.connected,
              ),
              refresh: input.props.progressCardRefresh?.state,
              onOpen: destinations.onOpenProgress,
            }
          : undefined,
      pullRequests: destinations?.onOpenPullRequest
        ? {
            items: orderSessionPullRequests(input.props.pullRequests ?? []),
            status: input.props.pullRequestsStatus ?? "ready",
            onOpen: destinations.onOpenPullRequest,
          }
        : undefined,
      publication:
        input.props.githubPublication && destinations?.publication?.eligible
          ? { view: input.props.githubPublication, onOpen: destinations.publication.onOpen }
          : undefined,
    };
  });
}
