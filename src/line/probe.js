import { messagingApi } from "@line/bot-sdk";
import { withTimeout } from "../utils/with-timeout.js";
export async function probeLineBot(channelAccessToken, timeoutMs = 5000) {
    if (!channelAccessToken?.trim()) {
        return { ok: false, error: "Channel access token not configured" };
    }
    const client = new messagingApi.MessagingApiClient({
        channelAccessToken: channelAccessToken.trim(),
    });
    try {
        const profile = await withTimeout(client.getBotInfo(), timeoutMs);
        return {
            ok: true,
            bot: {
                displayName: profile.displayName,
                userId: profile.userId,
                basicId: profile.basicId,
                pictureUrl: profile.pictureUrl,
            },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
    }
}
