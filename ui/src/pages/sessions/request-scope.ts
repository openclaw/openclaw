import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";

/** The page generation and exact connection captured before session interactions. */
export type SessionsPageRequestScope = {
  epoch: number;
  signal: AbortSignal;
  context: ApplicationContext;
  gateway: ApplicationContext["gateway"];
  sessions: ApplicationContext["sessions"];
  client: GatewayBrowserClient;
};
