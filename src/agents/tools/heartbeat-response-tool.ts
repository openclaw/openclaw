/**
 * Auto-reply heartbeat turns use this tool to accept the agent's outcome,
 * notification decision, and next-check metadata exactly once per turn.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  HEARTBEAT_TOOL_OUTCOMES,
  HEARTBEAT_TOOL_PRIORITIES,
  normalizeHeartbeatToolResponse,
} from "../../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertCronJobScratchContent } from "../../cron/scratch-contract.js";
import { isHeartbeatEnabledForAgent } from "../../infra/heartbeat-summary.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { optionalStringEnum, stringEnum } from "../schema/string-enum.js";
import type { AnyAgentTool } from "./common.js";
import { textResult, ToolInputError } from "./common.js";

const HeartbeatResponseToolSchema = Type.Object(
  {
    outcome: stringEnum(HEARTBEAT_TOOL_OUTCOMES),
    notify: Type.Boolean(),
    summary: Type.String(),
    notificationText: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    priority: optionalStringEnum(HEARTBEAT_TOOL_PRIORITIES),
    nextCheck: Type.Optional(Type.String()),
    scratch: Type.Optional(
      Type.String({
        description: "Complete replacement for heartbeat monitor prose; not a recurring schedule.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Creates the one-shot heartbeat response tool for an auto-reply turn. */
/**
 * A heartbeat-enabled agent offers the tool on every turn, so heartbeat turns keep the
 * session's tool definitions; only a heartbeat run accepts a response.
 */
export function resolveHeartbeatTools(
  options:
    | {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        trigger?: string;
        config?: OpenClawConfig;
      }
    | undefined,
  agentId?: string,
): { enableHeartbeatTool: boolean; offerHeartbeatTool: boolean } {
  const enableHeartbeatTool =
    options?.enableHeartbeatTool === true ||
    (options?.trigger === "heartbeat" &&
      options?.config?.messages?.visibleReplies === "message_tool");
  return {
    enableHeartbeatTool,
    offerHeartbeatTool:
      enableHeartbeatTool ||
      options?.forceHeartbeatTool === true ||
      (options?.config !== undefined && isHeartbeatEnabledForAgent(options.config, agentId)),
  };
}

/** Every turn of a heartbeat-enabled session offers the tool; only a heartbeat run accepts it. */
export function resolveHeartbeatResponseTool(options?: {
  enableHeartbeatTool?: boolean;
  offerHeartbeatTool?: boolean;
}): AnyAgentTool | null {
  return options?.enableHeartbeatTool || options?.offerHeartbeatTool
    ? createHeartbeatResponseTool({ acceptsResponses: options.enableHeartbeatTool === true })
    : null;
}

function createHeartbeatResponseTool(options: { acceptsResponses?: boolean } = {}): AnyAgentTool {
  let recorded = false;
  return {
    label: "Heartbeat",
    name: HEARTBEAT_RESPONSE_TOOL_NAME,
    // Heartbeat prompts instruct the model to call this one-shot tool; hiding
    // it behind tool search would break the heartbeat contract.
    catalogMode: "direct-only",
    displaySummary: "Accept heartbeat outcome/notify choice.",
    description:
      "Accept heartbeat result for post-turn handling. `notify=false` no visible send. `notify=true` needs concise notificationText. Scratch is monitor prose only.",
    parameters: HeartbeatResponseToolSchema,
    execute: async (_toolCallId, args) => {
      if (options.acceptsResponses === false) {
        // Offered for tool-list stability; preserve the run's configured reply mode.
        throw new ToolInputError(
          "heartbeat_respond is not accepted in this run; follow the configured reply instructions instead",
        );
      }
      if (!isRecord(args)) {
        throw new ToolInputError("Heartbeat response arguments required");
      }
      if (typeof readSnakeCaseParamRaw(args, "notify") !== "boolean") {
        throw new ToolInputError("notify required");
      }
      if (typeof args.scratch === "string") {
        try {
          assertCronJobScratchContent(args.scratch);
        } catch (error) {
          throw new ToolInputError(error instanceof Error ? error.message : String(error));
        }
      }
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new ToolInputError(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      if (recorded) {
        // One heartbeat turn should produce one decision; repeated calls can
        // otherwise overwrite the notify/no-notify choice.
        throw new ToolInputError("heartbeat_respond already accepted for this turn");
      }
      recorded = true;
      const { scratch, ...publicResponse } = response;
      const details = { status: "accepted" as const, ...publicResponse } as typeof response & {
        status: "accepted";
      };
      if (scratch !== undefined) {
        // Keep future prompt content out of model-visible tool output and logs;
        // the runner receives it through the internal result details only.
        Object.defineProperty(details, "scratch", { value: scratch, enumerable: false });
      }
      return textResult(
        JSON.stringify(
          {
            status: "accepted",
            ...publicResponse,
            ...(scratch !== undefined
              ? {
                  // Persistence is a runner-side CAS after the turn; do not claim
                  // success here. A lost race is logged and retryable next beat.
                  scratchPending: true,
                  scratchBytes: Buffer.byteLength(scratch, "utf8"),
                }
              : {}),
          },
          null,
          2,
        ),
        details,
      );
    },
  };
}
