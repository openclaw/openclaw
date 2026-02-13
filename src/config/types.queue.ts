export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "steer+backlog"
  | "queue"
  | "interrupt";
export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueModeByProvider = {
  whatsapp?: QueueMode;
  telegram?: QueueMode;
  slack?: QueueMode;
  webchat?: QueueMode;
};
