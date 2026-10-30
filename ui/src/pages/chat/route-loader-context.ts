import type { ApplicationContext } from "../../app/context.ts";

export type SessionRouteContext = Pick<
  ApplicationContext,
  | "offlineSessionDefaults"
  | "agents"
  | "agentSelection"
  | "basePath"
  | "gateway"
  | "sessions"
  | "router"
  | "lifecycleAbortSignal"
>;
