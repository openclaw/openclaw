import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
// Prefix for OpenClaw-generated action IDs to scope our handler
const OPENCLAW_ACTION_PREFIX = "openclaw:";
const SLACK_INTERACTION_EVENT_PREFIX = "Slack interaction: ";
const REDACTED_INTERACTION_VALUE = "[redacted]";
const SLACK_INTERACTION_EVENT_MAX_CHARS = 2400;
const SLACK_INTERACTION_STRING_MAX_CHARS = 160;
const SLACK_INTERACTION_ARRAY_MAX_ITEMS = 64;
const SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS = 3;
const SLACK_INTERACTION_REDACTED_KEYS = new Set([
    "triggerId",
    "responseUrl",
    "workflowTriggerUrl",
    "privateMetadata",
    "viewHash",
]);
function truncateInteractionString(value, max = SLACK_INTERACTION_STRING_MAX_CHARS) {
    const trimmed = value.trim();
    if (trimmed.length <= max) {
        return trimmed;
    }
    return `${trimmed.slice(0, max - 1)}…`;
}
function sanitizeSlackInteractionPayloadValue(value, key) {
    if (value === undefined) {
        return undefined;
    }
    if (key && SLACK_INTERACTION_REDACTED_KEYS.has(key)) {
        if (typeof value !== "string" || value.trim().length === 0) {
            return undefined;
        }
        return REDACTED_INTERACTION_VALUE;
    }
    if (typeof value === "string") {
        return truncateInteractionString(value);
    }
    if (Array.isArray(value)) {
        const sanitized = value
            .slice(0, SLACK_INTERACTION_ARRAY_MAX_ITEMS)
            .map((entry) => sanitizeSlackInteractionPayloadValue(entry))
            .filter((entry) => entry !== undefined);
        if (value.length > SLACK_INTERACTION_ARRAY_MAX_ITEMS) {
            sanitized.push(`…+${value.length - SLACK_INTERACTION_ARRAY_MAX_ITEMS} more`);
        }
        return sanitized;
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
        const sanitized = sanitizeSlackInteractionPayloadValue(entryValue, entryKey);
        if (sanitized === undefined) {
            continue;
        }
        if (typeof sanitized === "string" && sanitized.length === 0) {
            continue;
        }
        if (Array.isArray(sanitized) && sanitized.length === 0) {
            continue;
        }
        output[entryKey] = sanitized;
    }
    return output;
}
function buildCompactSlackInteractionPayload(payload) {
    const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
    const compactInputs = rawInputs
        .slice(0, SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS)
        .flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
            return [];
        }
        const typed = entry;
        return [
            {
                actionId: typed.actionId,
                blockId: typed.blockId,
                actionType: typed.actionType,
                inputKind: typed.inputKind,
                selectedValues: typed.selectedValues,
                selectedLabels: typed.selectedLabels,
                inputValue: typed.inputValue,
                inputNumber: typed.inputNumber,
                selectedDate: typed.selectedDate,
                selectedTime: typed.selectedTime,
                selectedDateTime: typed.selectedDateTime,
                richTextPreview: typed.richTextPreview,
            },
        ];
    });
    return {
        interactionType: payload.interactionType,
        actionId: payload.actionId,
        callbackId: payload.callbackId,
        actionType: payload.actionType,
        userId: payload.userId,
        teamId: payload.teamId,
        channelId: payload.channelId ?? payload.routedChannelId,
        messageTs: payload.messageTs,
        threadTs: payload.threadTs,
        viewId: payload.viewId,
        isCleared: payload.isCleared,
        selectedValues: payload.selectedValues,
        selectedLabels: payload.selectedLabels,
        selectedDate: payload.selectedDate,
        selectedTime: payload.selectedTime,
        selectedDateTime: payload.selectedDateTime,
        workflowId: payload.workflowId,
        routedChannelType: payload.routedChannelType,
        inputs: compactInputs.length > 0 ? compactInputs : undefined,
        inputsOmitted: rawInputs.length > SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
            ? rawInputs.length - SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
            : undefined,
        payloadTruncated: true,
    };
}
function formatSlackInteractionSystemEvent(payload) {
    const toEventText = (value) => `${SLACK_INTERACTION_EVENT_PREFIX}${JSON.stringify(value)}`;
    const sanitizedPayload = sanitizeSlackInteractionPayloadValue(payload) ?? {};
    let eventText = toEventText(sanitizedPayload);
    if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
        return eventText;
    }
    const compactPayload = sanitizeSlackInteractionPayloadValue(buildCompactSlackInteractionPayload(sanitizedPayload));
    eventText = toEventText(compactPayload);
    if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
        return eventText;
    }
    return toEventText({
        interactionType: sanitizedPayload.interactionType,
        actionId: sanitizedPayload.actionId ?? "unknown",
        userId: sanitizedPayload.userId,
        channelId: sanitizedPayload.channelId ?? sanitizedPayload.routedChannelId,
        payloadTruncated: true,
    });
}
function readOptionValues(options) {
    if (!Array.isArray(options)) {
        return undefined;
    }
    const values = options
        .map((option) => (option && typeof option === "object" ? option.value : null))
        .filter((value) => typeof value === "string" && value.trim().length > 0);
    return values.length > 0 ? values : undefined;
}
function readOptionLabels(options) {
    if (!Array.isArray(options)) {
        return undefined;
    }
    const labels = options
        .map((option) => option && typeof option === "object" ? (option.text?.text ?? null) : null)
        .filter((label) => typeof label === "string" && label.trim().length > 0);
    return labels.length > 0 ? labels : undefined;
}
function uniqueNonEmptyStrings(values) {
    const unique = [];
    const seen = new Set();
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
function collectRichTextFragments(value, out) {
    if (!value || typeof value !== "object") {
        return;
    }
    const typed = value;
    if (typeof typed.text === "string" && typed.text.trim().length > 0) {
        out.push(typed.text.trim());
    }
    if (Array.isArray(typed.elements)) {
        for (const child of typed.elements) {
            collectRichTextFragments(child, out);
        }
    }
}
function summarizeRichTextPreview(value) {
    const fragments = [];
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
function readInteractionAction(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
    }
    return raw;
}
function summarizeAction(action) {
    const typed = action;
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
    const inputNumber = actionType === "number_input" && inputValue != null ? Number.parseFloat(inputValue) : undefined;
    const parsedNumber = Number.isFinite(inputNumber) ? inputNumber : undefined;
    const inputEmail = actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : undefined;
    let inputUrl;
    if (actionType === "url_text_input" && inputValue) {
        try {
            // Normalize to a canonical URL string so downstream handlers do not need to reparse.
            inputUrl = new URL(inputValue).toString();
        }
        catch {
            inputUrl = undefined;
        }
    }
    const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : undefined;
    const richTextPreview = summarizeRichTextPreview(richTextValue);
    const inputKind = actionType === "number_input"
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
        selectedDateTime: typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
        inputValue,
        inputNumber: parsedNumber,
        inputEmail,
        inputUrl,
        richTextValue,
        richTextPreview,
        workflowTriggerUrl: typed.workflow?.trigger_url,
        workflowId: typed.workflow?.workflow_id,
    };
}
function isBulkActionsBlock(block) {
    return (block.type === "actions" &&
        Array.isArray(block.elements) &&
        block.elements.length > 0 &&
        block.elements.every((el) => typeof el.action_id === "string" && el.action_id.includes("_all_")));
}
function formatInteractionSelectionLabel(params) {
    if (params.summary.actionType === "button" && params.buttonText?.trim()) {
        return params.buttonText.trim();
    }
    if (params.summary.selectedLabels?.length) {
        if (params.summary.selectedLabels.length <= 3) {
            return params.summary.selectedLabels.join(", ");
        }
        return `${params.summary.selectedLabels.slice(0, 3).join(", ")} +${params.summary.selectedLabels.length - 3}`;
    }
    if (params.summary.selectedValues?.length) {
        if (params.summary.selectedValues.length <= 3) {
            return params.summary.selectedValues.join(", ");
        }
        return `${params.summary.selectedValues.slice(0, 3).join(", ")} +${params.summary.selectedValues.length - 3}`;
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
function formatInteractionConfirmationText(params) {
    const actor = params.userId?.trim() ? ` by <@${params.userId.trim()}>` : "";
    return `:white_check_mark: *${escapeSlackMrkdwn(params.selectedLabel)}* selected${actor}`;
}
function summarizeViewState(values) {
    if (!values || typeof values !== "object") {
        return [];
    }
    const entries = [];
    for (const [blockId, blockValue] of Object.entries(values)) {
        if (!blockValue || typeof blockValue !== "object") {
            continue;
        }
        for (const [actionId, rawAction] of Object.entries(blockValue)) {
            if (!rawAction || typeof rawAction !== "object") {
                continue;
            }
            const actionSummary = summarizeAction(rawAction);
            entries.push({
                blockId,
                actionId,
                ...actionSummary,
            });
        }
    }
    return entries;
}
function resolveModalSessionRouting(params) {
    const metadata = params.metadata;
    if (metadata.sessionKey) {
        return {
            sessionKey: metadata.sessionKey,
            channelId: metadata.channelId,
            channelType: metadata.channelType,
        };
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
function summarizeSlackViewLifecycleContext(view) {
    const rootViewId = view.root_view_id;
    const previousViewId = view.previous_view_id;
    const externalId = view.external_id;
    const viewHash = view.hash;
    return {
        rootViewId,
        previousViewId,
        externalId,
        viewHash,
        isStackedView: Boolean(previousViewId),
    };
}
function resolveSlackModalEventBase(params) {
    const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
    const callbackId = params.body.view?.callback_id ?? "unknown";
    const userId = params.body.user?.id ?? "unknown";
    const viewId = params.body.view?.id;
    const inputs = summarizeViewState(params.body.view?.state?.values);
    const sessionRouting = resolveModalSessionRouting({
        ctx: params.ctx,
        metadata,
    });
    return {
        callbackId,
        userId,
        expectedUserId: metadata.userId,
        viewId,
        sessionRouting,
        payload: {
            actionId: `view:${callbackId}`,
            callbackId,
            viewId,
            userId,
            teamId: params.body.team?.id,
            ...summarizeSlackViewLifecycleContext({
                root_view_id: params.body.view?.root_view_id,
                previous_view_id: params.body.view?.previous_view_id,
                external_id: params.body.view?.external_id,
                hash: params.body.view?.hash,
            }),
            privateMetadata: params.body.view?.private_metadata,
            routedChannelId: sessionRouting.channelId,
            routedChannelType: sessionRouting.channelType,
            inputs,
        },
    };
}
async function emitSlackModalLifecycleEvent(params) {
    const { callbackId, userId, expectedUserId, viewId, sessionRouting, payload } = resolveSlackModalEventBase({
        ctx: params.ctx,
        body: params.body,
    });
    const isViewClosed = params.interactionType === "view_closed";
    const isCleared = params.body.is_cleared === true;
    const eventPayload = isViewClosed
        ? {
            interactionType: params.interactionType,
            ...payload,
            isCleared,
        }
        : {
            interactionType: params.interactionType,
            ...payload,
        };
    if (isViewClosed) {
        params.ctx.runtime.log?.(`slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`);
    }
    else {
        params.ctx.runtime.log?.(`slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`);
    }
    if (!expectedUserId) {
        params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`);
        return;
    }
    const auth = await authorizeSlackSystemEventSender({
        ctx: params.ctx,
        senderId: userId,
        channelId: sessionRouting.channelId,
        channelType: sessionRouting.channelType,
        expectedSenderId: expectedUserId,
    });
    if (!auth.allowed) {
        params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`);
        return;
    }
    enqueueSystemEvent(formatSlackInteractionSystemEvent(eventPayload), {
        sessionKey: sessionRouting.sessionKey,
        contextKey: [params.contextPrefix, callbackId, viewId, userId].filter(Boolean).join(":"),
    });
}
function registerModalLifecycleHandler(params) {
    params.register(params.matcher, async ({ ack, body }) => {
        await ack();
        if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
            params.ctx.runtime.log?.(`slack:interaction drop ${params.interactionType} payload (mismatched app/team)`);
            return;
        }
        await emitSlackModalLifecycleEvent({
            ctx: params.ctx,
            body: body,
            interactionType: params.interactionType,
            contextPrefix: params.contextPrefix,
        });
    });
}
export function registerSlackInteractionEvents(params) {
    const { ctx } = params;
    if (typeof ctx.app.action !== "function") {
        return;
    }
    // Handle Block Kit button clicks from OpenClaw-generated messages
    // Only matches action_ids that start with our prefix to avoid interfering
    // with other Slack integrations or future features
    ctx.app.action(new RegExp(`^${OPENCLAW_ACTION_PREFIX}`), async (args) => {
        const { ack, body, action, respond } = args;
        const typedBody = body;
        // Acknowledge the action immediately to prevent the warning icon
        await ack();
        if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
            ctx.runtime.log?.("slack:interaction drop block action payload (mismatched app/team)");
            return;
        }
        // Extract action details using proper Bolt types
        const typedAction = readInteractionAction(action);
        if (!typedAction) {
            ctx.runtime.log?.(`slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${typedBody.user?.id ?? "unknown"}`);
            return;
        }
        const typedActionWithText = typedAction;
        const actionId = typeof typedActionWithText.action_id === "string"
            ? typedActionWithText.action_id
            : "unknown";
        const blockId = typedActionWithText.block_id;
        const userId = typedBody.user?.id ?? "unknown";
        const channelId = typedBody.channel?.id ?? typedBody.container?.channel_id;
        const messageTs = typedBody.message?.ts ?? typedBody.container?.message_ts;
        const threadTs = typedBody.container?.thread_ts;
        const auth = await authorizeSlackSystemEventSender({
            ctx,
            senderId: userId,
            channelId,
        });
        if (!auth.allowed) {
            ctx.runtime.log?.(`slack:interaction drop action=${actionId} user=${userId} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
            if (respond) {
                try {
                    await respond({
                        text: "You are not authorized to use this control.",
                        response_type: "ephemeral",
                    });
                }
                catch {
                    // Best-effort feedback only.
                }
            }
            return;
        }
        const actionSummary = summarizeAction(typedAction);
        const eventPayload = {
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
        ctx.runtime.log?.(`slack:interaction action=${actionId} type=${actionSummary.actionType ?? "unknown"} user=${userId} channel=${channelId}`);
        // Send a system event to notify the agent about the button click
        // Pass undefined (not "unknown") to allow proper main session fallback
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
            channelId: channelId,
            channelType: auth.channelType,
        });
        // Build context key - only include defined values to avoid "unknown" noise
        const contextParts = ["slack:interaction", channelId, messageTs, actionId].filter(Boolean);
        const contextKey = contextParts.join(":");
        enqueueSystemEvent(formatSlackInteractionSystemEvent(eventPayload), {
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
            buttonText: typedActionWithText.text?.text,
        });
        let updatedBlocks = originalBlocks.map((block) => {
            const typedBlock = block;
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
            const typedBlock = block;
            return typedBlock.type === "actions" && !isBulkActionsBlock(typedBlock);
        });
        if (!hasRemainingIndividualActionRows) {
            updatedBlocks = updatedBlocks.filter((block, index) => {
                const typedBlock = block;
                if (isBulkActionsBlock(typedBlock)) {
                    return false;
                }
                if (typedBlock.type !== "divider") {
                    return true;
                }
                const next = updatedBlocks[index + 1];
                return !next || !isBulkActionsBlock(next);
            });
        }
        try {
            await ctx.app.client.chat.update({
                channel: channelId,
                ts: messageTs,
                text: typedBody.message?.text ?? "",
                blocks: updatedBlocks,
            });
        }
        catch {
            // If update fails, fallback to ephemeral confirmation for immediate UX feedback.
            if (!respond) {
                return;
            }
            try {
                await respond({
                    text: `Button "${actionId}" clicked!`,
                    response_type: "ephemeral",
                });
            }
            catch {
                // Action was acknowledged and system event enqueued even when response updates fail.
            }
        }
    });
    if (typeof ctx.app.view !== "function") {
        return;
    }
    const modalMatcher = new RegExp(`^${OPENCLAW_ACTION_PREFIX}`);
    // Handle OpenClaw modal submissions with callback_ids scoped by our prefix.
    registerModalLifecycleHandler({
        register: (matcher, handler) => ctx.app.view(matcher, handler),
        matcher: modalMatcher,
        ctx,
        interactionType: "view_submission",
        contextPrefix: "slack:interaction:view",
    });
    const viewClosed = ctx.app.viewClosed;
    if (typeof viewClosed !== "function") {
        return;
    }
    // Handle modal close events so agent workflows can react to cancelled forms.
    registerModalLifecycleHandler({
        register: viewClosed,
        matcher: modalMatcher,
        ctx,
        interactionType: "view_closed",
        contextPrefix: "slack:interaction:view-closed",
    });
}
