import type { BlockAction, SlackActionMiddlewareArgs } from "@slack/bolt";
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

type SelectOption = {
  value?: string;
  text?: { text?: string };
};

type InteractionSummary = {
  actionId: string;
  blockId?: string;
  actionType?: string;
  value?: string;
  selectedValues?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  inputValue?: string;
  userId?: string;
  channelId?: string;
  messageTs?: string;
};

function readOptionValues(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const values = options
    .map((option) => (option && typeof option === "object" ? (option as SelectOption).value : null))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function readOptionLabels(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const labels = options
    .map((option) =>
      option && typeof option === "object" ? ((option as SelectOption).text?.text ?? null) : null,
    )
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0);
  return labels.length > 0 ? labels : undefined;
}

function summarizeAction(action: BlockAction): Omit<InteractionSummary, "actionId" | "blockId"> {
  const typed = action as BlockAction & {
    selected_option?: SelectOption;
    selected_options?: SelectOption[];
    selected_user?: string;
    selected_users?: string[];
    selected_channel?: string;
    selected_channels?: string[];
    selected_conversation?: string;
    selected_conversations?: string[];
    selected_date?: string;
    selected_time?: string;
    selected_date_time?: number;
    value?: string;
  };
  const actionType = typed.type;
  const selectedValues = [
    ...(typed.selected_option?.value ? [typed.selected_option.value] : []),
    ...(readOptionValues(typed.selected_options) ?? []),
    ...(typed.selected_user ? [typed.selected_user] : []),
    ...(Array.isArray(typed.selected_users) ? typed.selected_users : []),
    ...(typed.selected_channel ? [typed.selected_channel] : []),
    ...(Array.isArray(typed.selected_channels) ? typed.selected_channels : []),
    ...(typed.selected_conversation ? [typed.selected_conversation] : []),
    ...(Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []),
  ].filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  const selectedLabels = readOptionLabels(typed.selected_options);

  return {
    actionType,
    value: typed.value,
    selectedValues: selectedValues.length > 0 ? selectedValues : undefined,
    selectedLabels,
    selectedDate: typed.selected_date,
    selectedTime: typed.selected_time,
    selectedDateTime:
      typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
    inputValue: actionType === "plain_text_input" ? typed.value : undefined,
  };
}

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
  if (typeof ctx.app.action !== "function") {
    return;
  }

  // Handle Block Kit button clicks from OpenClaw-generated messages
  // Only matches action_ids that start with our prefix to avoid interfering
  // with other Slack integrations or future features
  ctx.app.action(
    new RegExp(`^${OPENCLAW_ACTION_PREFIX}`),
    async (args: SlackActionMiddlewareArgs<BlockAction>) => {
      const { ack, body, action, respond } = args;

      // Acknowledge the action immediately to prevent the warning icon
      await ack();

      // Extract action details using proper Bolt types
      const actionId = action.action_id;
      const blockId = action.block_id;
      const userId = body.user.id;
      const channelId = body.channel?.id;
      const messageTs = body.message?.ts;
      const actionSummary = summarizeAction(action);
      const eventPayload: InteractionSummary = {
        actionId,
        blockId,
        ...actionSummary,
        userId,
        channelId,
        messageTs,
      };

      // Log the interaction for debugging
      ctx.runtime.log?.(
        `slack:interaction action=${actionId} type=${actionSummary.actionType ?? "unknown"} user=${userId} channel=${channelId}`,
      );

      // Send a system event to notify the agent about the button click
      // Pass undefined (not "unknown") to allow proper main session fallback
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: channelId,
        channelType: "channel",
      });

      // Build context key - only include defined values to avoid "unknown" noise
      const contextParts = ["slack:interaction", channelId, messageTs, actionId].filter(Boolean);
      const contextKey = contextParts.join(":");

      enqueueSystemEvent(`Slack interaction: ${JSON.stringify(eventPayload)}`, {
        sessionKey,
        contextKey,
      });

      const originalBlocks = (body.message as { blocks?: unknown[] } | undefined)?.blocks;
      if (!Array.isArray(originalBlocks) || !channelId || !messageTs) {
        return;
      }

      if (action.type !== "button") {
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
