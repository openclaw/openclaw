import type { BlockAction, ButtonAction, Middleware, SlackActionMiddlewareArgs } from "@slack/bolt";
import type { SlackMonitorContext } from "../context.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

// Prefix for OpenClaw-generated action IDs to scope our handler
const OPENCLAW_ACTION_PREFIX = "openclaw:";

export function registerSlackInteractionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // Handle Block Kit button clicks from OpenClaw-generated messages
  // Only matches action_ids that start with our prefix to avoid interfering
  // with other Slack integrations or future features
  ctx.app.action(
    new RegExp(`^${OPENCLAW_ACTION_PREFIX}`),
    async (args: SlackActionMiddlewareArgs<BlockAction<ButtonAction>>) => {
      const { ack, body, action, respond } = args;

      // Acknowledge the action immediately to prevent the warning icon
      await ack();

      // Extract action details using proper Bolt types
      const actionId = action.action_id;
      const blockId = action.block_id;
      const value = action.value;
      const userId = body.user.id;
      const channelId = body.channel?.id;
      const messageTs = body.message?.ts;

      // Log the interaction for debugging
      ctx.runtime.log?.(`slack:interaction action=${actionId} user=${userId} channel=${channelId}`);

      // Send a system event to notify the agent about the button click
      // Pass undefined (not "unknown") to allow proper main session fallback
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: channelId,
        channelType: "channel",
      });

      // Build context key - only include defined values to avoid "unknown" noise
      const contextParts = ["slack:interaction", channelId, messageTs, actionId].filter(Boolean);
      const contextKey = contextParts.join(":");

      enqueueSystemEvent(
        `Slack button clicked: actionId=${actionId} value=${value ?? "none"} user=${userId}`,
        {
          sessionKey,
          contextKey,
        },
      );

      // Send an ephemeral confirmation to the user
      // This gives immediate feedback that the click was received
      if (respond) {
        try {
          await respond({
            text: `Button "${actionId}" clicked!`,
            response_type: "ephemeral",
          });
        } catch {
          // If respond fails, the action was still acknowledged
          // The system event will notify the agent
        }
      }
    },
  );
}
