import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";

export function hasVisibleChatActivityPills(props: ChatActivityPillsProps): boolean {
  return (
    Boolean(props.goal && !props.goal.hidden) ||
    (!props.approvalPending &&
      Boolean(
        props.subagents?.activities.some(
          (agent) => agent.status === "running" || agent.status === "waiting",
        ) ||
        props.progress?.showInChat ||
        props.pullRequests?.items.length ||
        props.publication,
      ))
  );
}
