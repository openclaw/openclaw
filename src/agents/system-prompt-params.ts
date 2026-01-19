import type { ClawdbotConfig } from "../config/config.js";
import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
  type ResolvedTimeFormat,
} from "./date-time.js";

export type RuntimeInfoInput = {
  agentId?: string;
  host: string;
  os: string;
  arch: string;
  node: string;
  model: string;
  channel?: string;
  capabilities?: string[];
};

export type SystemPromptRuntimeParams = {
  runtimeInfo: RuntimeInfoInput;
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
};

export function buildSystemPromptParams(params: {
  config?: ClawdbotConfig;
  agentId?: string;
  runtime: Omit<RuntimeInfoInput, "agentId">;
}): SystemPromptRuntimeParams {
  const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
  const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
  return {
    runtimeInfo: {
      agentId: params.agentId,
      ...params.runtime,
    },
    userTimezone,
    userTime,
    userTimeFormat,
  };
}
