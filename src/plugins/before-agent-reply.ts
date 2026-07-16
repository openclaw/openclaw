import { runOncePerAgentRun } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
} from "./hook-types.js";

const BEFORE_AGENT_REPLY_TRIGGERS = new Set(["user", "heartbeat", "cron"]);

/** Runs the reply claim hook once for one admitted turn, across model fallbacks. */
export function runBeforeAgentReplyForTurn(params: {
  runId: string;
  trigger?: string;
  event: PluginHookBeforeAgentReplyEvent;
  context: PluginHookAgentContext;
  onDispatch?: () => void;
  onDeclined?: () => void;
}): Promise<PluginHookBeforeAgentReplyResult | undefined> {
  if (!params.trigger || !BEFORE_AGENT_REPLY_TRIGGERS.has(params.trigger)) {
    return Promise.resolve(undefined);
  }
  return runOncePerAgentRun(params.runId, "before_agent_reply", async () => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("before_agent_reply")) {
      return undefined;
    }
    params.onDispatch?.();
    const result = await hookRunner.runBeforeAgentReply(params.event, params.context);
    if (!result?.handled) {
      params.onDeclined?.();
    }
    return result;
  });
}
