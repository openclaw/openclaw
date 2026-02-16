import type { BlockAction, ButtonAction, SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type { SlackMonitorContext } from "../context.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

// Prefix for OpenClaw-generated action IDs to scope our handler
const OPENCLAW_ACTION_PREFIX = "openclaw:";

type InteractionMessageBlock = {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
};

function isBulkActionsBlock(block: InteractionMessageBlock): boolean {
  return (
    block.type === "actions" &&
    Array.isArray(block.elements) &&
    block.elements.length > 0 &&
    block.elements.every((el) => typeof el.action_id === "string" && el.action_id.includes("_all_"))
  );
}

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

      const originalBlocks = (body.message as { blocks?: unknown[] } | undefined)?.blocks;
      if (!Array.isArray(originalBlocks) || !channelId || !messageTs) {
        return;
      }

      const buttonText = action.text?.text ?? actionId;
      let updatedBlocks = originalBlocks.map((block) => {
        const typedBlock = block as InteractionMessageBlock;
        if (typedBlock.type === "actions" && typedBlock.block_id === blockId) {
          return {
            type: "context",
            elements: [{ type: "mrkdwn", text: `:white_check_mark: *${buttonText}* selected` }],
          };
        }
        return block;
      });

      const hasRemainingIndividualActionRows = updatedBlocks.some((block) => {
        const typedBlock = block as InteractionMessageBlock;
        return typedBlock.type === "actions" && !isBulkActionsBlock(typedBlock);
      });

      if (!hasRemainingIndividualActionRows) {
        updatedBlocks = updatedBlocks.filter((block, index) => {
          const typedBlock = block as InteractionMessageBlock;
          if (isBulkActionsBlock(typedBlock)) {
            return false;
          }
          if (typedBlock.type !== "divider") {
            return true;
          }
          const next = updatedBlocks[index + 1] as InteractionMessageBlock | undefined;
          return !next || !isBulkActionsBlock(next);
        });
      }

      try {
        await ctx.app.client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: (body.message as { text?: string } | undefined)?.text ?? "",
          blocks: updatedBlocks as (Block | KnownBlock)[],
        });
      } catch {
        // If update fails, fallback to ephemeral confirmation for immediate UX feedback.
        if (!respond) {
          return;
        }
        try {
          await respond({
            text: `Button "${actionId}" clicked!`,
            response_type: "ephemeral",
          });
        } catch {
          // Action was acknowledged and system event enqueued even when response updates fail.
        }
      }
    },
  );
}
