import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
} from "../../agents/tools/in-process-gateway.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  summarizeUpdateRunResponse,
} from "../../gateway/update-run-summary.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { renderUpdateRunSummary } from "../../infra/update-run-notice.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { commandReply, defineGatewayControlCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleUpdateCommand: CommandHandler = defineGatewayControlCommand(
  "/update",
  async (params) => {
    try {
      const gatewayOptions = {
        resolveGatewayContext:
          readChannelContextGatewayContextResolver(params.ctx) ?? getInProcessGatewayToolContext,
        timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
      };
      const response = await callInProcessGatewayTool(
        "update.run",
        {
          sessionKey: params.sessionKey,
          note: "/update",
          requester: {
            channel: params.command.channel ?? params.ctx.Provider,
            accountId: params.ctx.AccountId,
            senderId: params.command.senderId,
          },
        },
        gatewayOptions,
      );
      const summary = summarizeUpdateRunResponse(response);
      // The Gateway sends the acknowledgement before handing off its process;
      // its durable notice owner also delivers completion and failure reports.
      if (summary.ackDelivered || summary.ackQueued) {
        return { shouldContinue: false };
      }
      if (summary.ok && summary.acknowledgement) {
        return commandReply(summary.acknowledgement);
      }
      if (summary.ok && summary.handoff?.status === "started") {
        return commandReply(renderUpdateRunSummary({ status: "running", reason: null }));
      }
      const run = summary.runId
        ? (
            await callInProcessGatewayTool<{ run: UpdateRunRecord | null }>(
              "update.runs.get",
              { runId: summary.runId },
              gatewayOptions,
            )
          ).run
        : undefined;
      if (!run) {
        throw new Error(
          summary.message ??
            summary.reason ??
            "Update run unavailable; run openclaw update status to inspect the outcome.",
        );
      }
      return commandReply(
        renderUpdateRunSummary(run, {
          manualCommand: summary.ok ? undefined : summary.handoff?.command,
        }),
      );
    } catch (err) {
      logVerbose(`Update request failed: ${formatErrorMessage(err)}`);
      return commandReply(
        "⚠️ Couldn't confirm the update. Open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
      );
    }
  },
);
