export type ActivityKind =
  | "inbound"
  | "route"
  | "queue"
  | "run"
  | "tool"
  | "reply"
  | "policy"
  | "error";

export type ActivityStatus =
  | "start"
  | "ok"
  | "error"
  | "skip"
  | "blocked"
  | "queued"
  | "dequeued"
  | "done";

export type ActivityMeta = {
  kind: ActivityKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  summary: string;
  status?: ActivityStatus;
  durationMs?: number;
  chars?: number;
  preview?: string;
  extra?: Record<string, string | number | boolean>;
};

export type ActivityRenderMode = "normal" | "full";

export type ActivityRenderOptions = {
  mode: ActivityRenderMode;
  time?: string;
  level?: string;
  subsystem?: string;
};
