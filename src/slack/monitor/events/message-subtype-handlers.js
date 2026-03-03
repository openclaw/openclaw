const changedHandler = {
    subtype: "message_changed",
    eventKind: "message_changed",
    describe: (channelLabel) => `Slack message edited in ${channelLabel}.`,
    contextKey: (event) => {
        const changed = event;
        const channelId = changed.channel ?? "unknown";
        const messageId = changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown";
        return `slack:message:changed:${channelId}:${messageId}`;
    },
    resolveSenderId: (event) => {
        const changed = event;
        return (changed.message?.user ??
            changed.previous_message?.user ??
            changed.message?.bot_id ??
            changed.previous_message?.bot_id);
    },
    resolveChannelId: (event) => event.channel,
    resolveChannelType: () => undefined,
};
const deletedHandler = {
    subtype: "message_deleted",
    eventKind: "message_deleted",
    describe: (channelLabel) => `Slack message deleted in ${channelLabel}.`,
    contextKey: (event) => {
        const deleted = event;
        const channelId = deleted.channel ?? "unknown";
        const messageId = deleted.deleted_ts ?? deleted.event_ts ?? "unknown";
        return `slack:message:deleted:${channelId}:${messageId}`;
    },
    resolveSenderId: (event) => {
        const deleted = event;
        return deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
    },
    resolveChannelId: (event) => event.channel,
    resolveChannelType: () => undefined,
};
const threadBroadcastHandler = {
    subtype: "thread_broadcast",
    eventKind: "thread_broadcast",
    describe: (channelLabel) => `Slack thread reply broadcast in ${channelLabel}.`,
    contextKey: (event) => {
        const thread = event;
        const channelId = thread.channel ?? "unknown";
        const messageId = thread.message?.ts ?? thread.event_ts ?? "unknown";
        return `slack:thread:broadcast:${channelId}:${messageId}`;
    },
    resolveSenderId: (event) => {
        const thread = event;
        return thread.user ?? thread.message?.user ?? thread.message?.bot_id;
    },
    resolveChannelId: (event) => event.channel,
    resolveChannelType: () => undefined,
};
const SUBTYPE_HANDLER_REGISTRY = {
    message_changed: changedHandler,
    message_deleted: deletedHandler,
    thread_broadcast: threadBroadcastHandler,
};
export function resolveSlackMessageSubtypeHandler(event) {
    const subtype = event.subtype;
    if (subtype !== "message_changed" &&
        subtype !== "message_deleted" &&
        subtype !== "thread_broadcast") {
        return undefined;
    }
    return SUBTYPE_HANDLER_REGISTRY[subtype];
}
