import type { GatewayRequestContext } from "./server-methods/types.js";

export type RestartResumeParams = {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};
