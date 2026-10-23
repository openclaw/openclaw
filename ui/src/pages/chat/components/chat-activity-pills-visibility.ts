import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";

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
