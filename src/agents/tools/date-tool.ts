import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import type { ClawdbotConfig } from "../../config/config.js";

const DateSchema = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description:
        "Optional IANA timezone name (e.g. 'Asia/Shanghai', 'America/New_York'). Defaults to the user's configured timezone.",
    }),
  ),
});

export function createDateTool(options?: { config?: ClawdbotConfig }): AnyAgentTool {
  return {
    label: "Date & Time",
    name: "date",
    description:
      "Get the current system date and time. ALWAYS call this tool when the user asks for the current time, or before scheduling any time-sensitive task. DO NOT rely on timestamps in the conversation history or your own internal clock.",
    parameters: DateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const configTimezone = options?.config?.agents?.defaults?.userTimezone;
      const requestedTimezone = readStringParam(params, "timezone");
      const timezone = resolveUserTimezone(requestedTimezone ?? configTimezone);
      const format = resolveUserTimeFormat(options?.config?.agents?.defaults?.timeFormat);

      const now = new Date();
      const formatted = formatUserTime(now, timezone, format);

      console.log(`[date-tool] Returning current time: ${formatted} (${now.toISOString()})`);

      return jsonResult({
        iso: now.toISOString(),
        timestampMs: now.getTime(),
        formatted,
        timezone,
      });
    },
  };
}
