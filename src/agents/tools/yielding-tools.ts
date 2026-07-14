import type { CronCreatorToolAllowlistEntry } from "./cron-tool.js";
import { callGatewayTool } from "./gateway.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";
import { createSleepTool, scheduleSleepWake } from "./sleep-tool.js";

type YieldingToolOptions = {
  sessionId?: string;
  agentSessionKey?: string;
  cronCreatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  onYield?: (message: string) => Promise<void> | void;
};

/** Creates immediate yield and, outside embedded mode, timer-backed sleep. */
export function createYieldingTools(embedded: boolean, options?: YieldingToolOptions) {
  const yieldTool = createSessionsYieldTool({
    sessionId: options?.sessionId,
    onYield: options?.onYield,
  });
  if (embedded) {
    return [yieldTool];
  }
  return [
    yieldTool,
    createSleepTool({
      sessionKey: options?.agentSessionKey,
      onYield: options?.onYield,
      scheduleWake: (seconds, message) =>
        scheduleSleepWake({
          seconds,
          message,
          sessionKey: options?.agentSessionKey,
          creatorToolAllowlist: options?.cronCreatorToolAllowlist,
          callGateway: callGatewayTool,
        }),
    }),
  ];
}
