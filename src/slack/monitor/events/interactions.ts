import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type { SlackMonitorContext } from "../context.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";

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
  interactionType?: "block_action" | "view_submission" | "view_closed";
  actionId: string;
  blockId?: string;
  actionType?: string;
  inputKind?: "text" | "number" | "email" | "url" | "rich_text";
  value?: string;
  selectedValues?: string[];
  selectedUsers?: string[];
  selectedChannels?: string[];
  selectedConversations?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  inputValue?: string;
  inputNumber?: number;
  inputEmail?: string;
  inputUrl?: string;
  richTextValue?: unknown;
  richTextPreview?: string;
  userId?: string;
  teamId?: string;
  triggerId?: string;
  responseUrl?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
};

type ModalInputSummary = {
  blockId: string;
  actionId: string;
  actionType?: string;
  inputKind?: "text" | "number" | "email" | "url" | "rich_text";
  value?: string;
  selectedValues?: string[];
  selectedUsers?: string[];
  selectedChannels?: string[];
  selectedConversations?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  inputValue?: string;
  inputNumber?: number;
  inputEmail?: string;
  inputUrl?: string;
  richTextValue?: unknown;
  richTextPreview?: string;
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

function uniqueNonEmptyStrings(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([*_`~])/g, "\\$1");
}

function collectRichTextFragments(value: unknown, out: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const typed = value as { text?: unknown; elements?: unknown };
  if (typeof typed.text === "string" && typed.text.trim().length > 0) {
    out.push(typed.text.trim());
  }
  if (Array.isArray(typed.elements)) {
    for (const child of typed.elements) {
      collectRichTextFragments(child, out);
    }
  }
}

function summarizeRichTextPreview(value: unknown): string | undefined {
  const fragments: string[] = [];
  collectRichTextFragments(value, fragments);
  if (fragments.length === 0) {
    return undefined;
  }
  const joined = fragments.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) {
    return undefined;
  }
  const max = 120;
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

function summarizeAction(
  action: Record<string, unknown>,
): Omit<InteractionSummary, "actionId" | "blockId"> {
  const typed = action as {
    type?: string;
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
    rich_text_value?: unknown;
  };
  const actionType = typed.type;
  const selectedUsers = uniqueNonEmptyStrings([
    ...(typed.selected_user ? [typed.selected_user] : []),
    ...(Array.isArray(typed.selected_users) ? typed.selected_users : []),
  ]);
  const selectedChannels = uniqueNonEmptyStrings([
    ...(typed.selected_channel ? [typed.selected_channel] : []),
    ...(Array.isArray(typed.selected_channels) ? typed.selected_channels : []),
  ]);
  const selectedConversations = uniqueNonEmptyStrings([
    ...(typed.selected_conversation ? [typed.selected_conversation] : []),
    ...(Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []),
  ]);
  const selectedValues = uniqueNonEmptyStrings([
    ...(typed.selected_option?.value ? [typed.selected_option.value] : []),
    ...(readOptionValues(typed.selected_options) ?? []),
    ...selectedUsers,
    ...selectedChannels,
    ...selectedConversations,
  ]);
  const selectedLabels = uniqueNonEmptyStrings([
    ...(typed.selected_option?.text?.text ? [typed.selected_option.text.text] : []),
    ...(readOptionLabels(typed.selected_options) ?? []),
  ]);
  const inputValue = typeof typed.value === "string" ? typed.value : undefined;
  const inputNumber =
    actionType === "number_input" && inputValue != null ? Number.parseFloat(inputValue) : undefined;
  const parsedNumber = Number.isFinite(inputNumber) ? inputNumber : undefined;
  const inputEmail =
    actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : undefined;
  let inputUrl: string | undefined;
  if (actionType === "url_text_input" && inputValue) {
    try {
      // Normalize to a canonical URL string so downstream handlers do not need to reparse.
      inputUrl = new URL(inputValue).toString();
    } catch {
      inputUrl = undefined;
    }
  }
  const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : undefined;
  const richTextPreview = summarizeRichTextPreview(richTextValue);
  const inputKind =
    actionType === "number_input"
      ? "number"
      : actionType === "email_text_input"
        ? "email"
        : actionType === "url_text_input"
          ? "url"
          : actionType === "rich_text_input"
            ? "rich_text"
            : inputValue != null
              ? "text"
              : undefined;

  return {
    actionType,
    inputKind,
    value: typed.value,
    selectedValues: selectedValues.length > 0 ? selectedValues : undefined,
    selectedUsers: selectedUsers.length > 0 ? selectedUsers : undefined,
    selectedChannels: selectedChannels.length > 0 ? selectedChannels : undefined,
    selectedConversations: selectedConversations.length > 0 ? selectedConversations : undefined,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : undefined,
    selectedDate: typed.selected_date,
    selectedTime: typed.selected_time,
    selectedDateTime:
      typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
    inputValue,
    inputNumber: parsedNumber,
    inputEmail,
    inputUrl,
    richTextValue,
    richTextPreview,
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

function formatInteractionSelectionLabel(params: {
  actionId: string;
  summary: Omit<InteractionSummary, "actionId" | "blockId">;
  buttonText?: string;
}): string {
  if (params.summary.actionType === "button" && params.buttonText?.trim()) {
    return params.buttonText.trim();
  }
  if (params.summary.selectedLabels?.length) {
    if (params.summary.selectedLabels.length <= 3) {
      return params.summary.selectedLabels.join(", ");
    }
    return `${params.summary.selectedLabels.slice(0, 3).join(", ")} +${
      params.summary.selectedLabels.length - 3
    }`;
  }
  if (params.summary.selectedValues?.length) {
    if (params.summary.selectedValues.length <= 3) {
      return params.summary.selectedValues.join(", ");
    }
    return `${params.summary.selectedValues.slice(0, 3).join(", ")} +${
      params.summary.selectedValues.length - 3
    }`;
  }
  if (params.summary.selectedDate) {
    return params.summary.selectedDate;
  }
  if (params.summary.selectedTime) {
    return params.summary.selectedTime;
  }
  if (typeof params.summary.selectedDateTime === "number") {
    return new Date(params.summary.selectedDateTime * 1000).toISOString();
  }
  if (params.summary.richTextPreview) {
    return params.summary.richTextPreview;
  }
  if (params.summary.value?.trim()) {
    return params.summary.value.trim();
  }
  return params.actionId;
}

function formatInteractionConfirmationText(params: {
  selectedLabel: string;
  userId?: string;
}): string {
  const actor = params.userId?.trim() ? ` by <@${params.userId.trim()}>` : "";
  return `:white_check_mark: *${escapeSlackMrkdwn(params.selectedLabel)}* selected${actor}`;
}

function summarizeViewState(values: unknown): ModalInputSummary[] {
  if (!values || typeof values !== "object") {
    return [];
  }
  const entries: ModalInputSummary[] = [];
  for (const [blockId, blockValue] of Object.entries(values as Record<string, unknown>)) {
    if (!blockValue || typeof blockValue !== "object") {
      continue;
    }
    for (const [actionId, rawAction] of Object.entries(blockValue as Record<string, unknown>)) {
      if (!rawAction || typeof rawAction !== "object") {
        continue;
      }
      const actionSummary = summarizeAction(rawAction as Record<string, unknown>);
      entries.push({
        blockId,
        actionId,
        ...actionSummary,
      });
    }
  }
  return entries;
}

function resolveModalSessionRouting(params: {
  ctx: SlackMonitorContext;
  privateMetadata: unknown;
}): { sessionKey: string; channelId?: string; channelType?: string } {
  const metadata = parseSlackModalPrivateMetadata(params.privateMetadata);
  if (metadata.sessionKey) {
    return { sessionKey: metadata.sessionKey };
  }
  if (metadata.channelId) {
    return {
      sessionKey: params.ctx.resolveSlackSystemEventSessionKey({
        channelId: metadata.channelId,
        channelType: metadata.channelType,
      }),
      channelId: metadata.channelId,
      channelType: metadata.channelType,
    };
  }
  return {
    sessionKey: params.ctx.resolveSlackSystemEventSessionKey({}),
  };
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
    async (args: SlackActionMiddlewareArgs) => {
      const { ack, body, action, respond } = args;
      const typedBody = body as unknown as {
        user?: { id?: string };
        team?: { id?: string };
        trigger_id?: string;
        response_url?: string;
        channel?: { id?: string };
        container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
        message?: { ts?: string; text?: string; blocks?: unknown[] };
      };

      // Acknowledge the action immediately to prevent the warning icon
      await ack();

      // Extract action details using proper Bolt types
      const typedAction = action as unknown as Record<string, unknown> & {
        action_id?: string;
        block_id?: string;
        type?: string;
        text?: { text?: string };
      };
      const actionId = typedAction.action_id ?? "unknown";
      const blockId = typedAction.block_id;
      const userId = typedBody.user?.id ?? "unknown";
      const channelId = typedBody.channel?.id ?? typedBody.container?.channel_id;
      const messageTs = typedBody.message?.ts ?? typedBody.container?.message_ts;
      const threadTs = typedBody.container?.thread_ts;
      const actionSummary = summarizeAction(typedAction);
      const eventPayload: InteractionSummary = {
        interactionType: "block_action",
        actionId,
        blockId,
        ...actionSummary,
        userId,
        teamId: typedBody.team?.id,
        triggerId: typedBody.trigger_id,
        responseUrl: typedBody.response_url,
        channelId,
        messageTs,
        threadTs,
      };

      // Log the interaction for debugging
      ctx.runtime.log?.(
        `slack:interaction action=${actionId} type=${actionSummary.actionType ?? "unknown"} user=${userId} channel=${channelId}`,
      );

      // Send a system event to notify the agent about the button click
      // Pass undefined (not "unknown") to allow proper main session fallback
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: channelId,
        channelType: undefined,
      });

      // Build context key - only include defined values to avoid "unknown" noise
      const contextParts = ["slack:interaction", channelId, messageTs, actionId].filter(Boolean);
      const contextKey = contextParts.join(":");

      enqueueSystemEvent(`Slack interaction: ${JSON.stringify(eventPayload)}`, {
        sessionKey,
        contextKey,
      });

      const originalBlocks = typedBody.message?.blocks;
      if (!Array.isArray(originalBlocks) || !channelId || !messageTs) {
        return;
      }

      if (!blockId) {
        return;
      }

      const selectedLabel = formatInteractionSelectionLabel({
        actionId,
        summary: actionSummary,
        buttonText: typedAction.text?.text,
      });
      let updatedBlocks = originalBlocks.map((block) => {
        const typedBlock = block as InteractionMessageBlock;
        if (typedBlock.type === "actions" && typedBlock.block_id === blockId) {
          return {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: formatInteractionConfirmationText({ selectedLabel, userId }),
              },
            ],
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
          text: typedBody.message?.text ?? "",
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

  if (typeof ctx.app.view !== "function") {
    return;
  }

  // Handle OpenClaw modal submissions with callback_ids scoped by our prefix.
  ctx.app.view(
    new RegExp(`^${OPENCLAW_ACTION_PREFIX}`),
    async ({ ack, body }: { ack: () => Promise<void>; body: unknown }) => {
      await ack();

      const typedBody = body as {
        user?: { id?: string };
        team?: { id?: string };
        view?: {
          id?: string;
          callback_id?: string;
          private_metadata?: string;
          state?: { values?: unknown };
        };
      };

      const callbackId = typedBody.view?.callback_id ?? "unknown";
      const userId = typedBody.user?.id ?? "unknown";
      const viewId = typedBody.view?.id;
      const inputs = summarizeViewState(typedBody.view?.state?.values);
      const sessionRouting = resolveModalSessionRouting({
        ctx,
        privateMetadata: typedBody.view?.private_metadata,
      });
      const eventPayload = {
        interactionType: "view_submission",
        actionId: `view:${callbackId}`,
        callbackId,
        viewId,
        userId,
        teamId: typedBody.team?.id,
        privateMetadata: typedBody.view?.private_metadata,
        routedChannelId: sessionRouting.channelId,
        routedChannelType: sessionRouting.channelType,
        inputs,
      };

      ctx.runtime.log?.(
        `slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${inputs.length}`,
      );

      enqueueSystemEvent(`Slack interaction: ${JSON.stringify(eventPayload)}`, {
        sessionKey: sessionRouting.sessionKey,
        contextKey: ["slack:interaction:view", callbackId, viewId, userId]
          .filter(Boolean)
          .join(":"),
      });
    },
  );

  const viewClosed = (
    ctx.app as unknown as {
      viewClosed?: (
        matcher: RegExp,
        handler: (args: { ack: () => Promise<void>; body: unknown }) => Promise<void>,
      ) => void;
    }
  ).viewClosed;
  if (typeof viewClosed !== "function") {
    return;
  }

  // Handle modal close events so agent workflows can react to cancelled forms.
  viewClosed(
    new RegExp(`^${OPENCLAW_ACTION_PREFIX}`),
    async ({ ack, body }: { ack: () => Promise<void>; body: unknown }) => {
      await ack();

      const typedBody = body as {
        user?: { id?: string };
        team?: { id?: string };
        view?: {
          id?: string;
          callback_id?: string;
          private_metadata?: string;
          state?: { values?: unknown };
        };
        is_cleared?: boolean;
      };

      const callbackId = typedBody.view?.callback_id ?? "unknown";
      const userId = typedBody.user?.id ?? "unknown";
      const viewId = typedBody.view?.id;
      const inputs = summarizeViewState(typedBody.view?.state?.values);
      const sessionRouting = resolveModalSessionRouting({
        ctx,
        privateMetadata: typedBody.view?.private_metadata,
      });
      const eventPayload = {
        interactionType: "view_closed",
        actionId: `view:${callbackId}`,
        callbackId,
        viewId,
        userId,
        teamId: typedBody.team?.id,
        isCleared: typedBody.is_cleared === true,
        privateMetadata: typedBody.view?.private_metadata,
        routedChannelId: sessionRouting.channelId,
        routedChannelType: sessionRouting.channelType,
        inputs,
      };

      ctx.runtime.log?.(
        `slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${
          typedBody.is_cleared === true
        }`,
      );

      enqueueSystemEvent(`Slack interaction: ${JSON.stringify(eventPayload)}`, {
        sessionKey: sessionRouting.sessionKey,
        contextKey: ["slack:interaction:view-closed", callbackId, viewId, userId]
          .filter(Boolean)
          .join(":"),
      });
    },
  );
}
