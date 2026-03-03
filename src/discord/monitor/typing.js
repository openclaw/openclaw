export async function sendTyping(params) {
    const channel = await params.client.fetchChannel(params.channelId);
    if (!channel) {
        return;
    }
    if ("triggerTyping" in channel && typeof channel.triggerTyping === "function") {
        await channel.triggerTyping();
    }
}
