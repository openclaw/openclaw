import { getRuntimeConfig } from "../../config/config.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import {
  PlacedSessionsSendSchema,
  PLACED_SESSIONS_SEND_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { executeSessionsSend } from "./sessions-send-executor.js";
import { createSelfHeldSendRetainer } from "./sessions-send-self-hold.js";
import { withSessionsSendRequesterSource } from "./sessions-send-session-source.js";
import { SessionsSendToolSchema, SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

export function createSessionsSendTool(opts?: SessionsSendToolOptions): AnyAgentTool {
  const retain = createSelfHeldSendRetainer(opts, (options, args) =>
    executeSessionsSend(options, "retained", args),
  );
  const tool: AnyAgentTool = {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SEND_DESCRIPTION
      : describeSessionsSendTool({
          allowThreadTargets:
            (opts?.config ?? getRuntimeConfig()).tools?.sessions?.allowThreadTargets === true,
        }),
    parameters: opts?.workerPlacement ? PlacedSessionsSendSchema : SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    execute: wrapGatewayPersonalToolExecution((toolCallId, args) =>
      executeSessionsSend(opts, toolCallId, args, retain),
    ),
  };
  const execute = tool.execute;
  tool.execute = (...args) => withSessionsSendRequesterSource(opts, () => execute(...args));
  return tool;
}
