import type { MoltbotConfig } from "../../config/config.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { type TwilioWebhookHandler, createTwilioWebhookHandler } from "./src/webhook.js";
import { TwilioClient } from "./src/client.js";

// Minimal config schema for now
const twilioConfigSchema = {
    parse: (config: unknown) => config as Record<string, unknown>,
};

const twilioMessagingPlugin: any = {
    id: "twilio-messaging",
    meta: {
        id: "twilio-messaging",
        label: "Twilio Messaging",
        selectionLabel: "Twilio",
        docsPath: "/twilio",
        blurb: "WhatsApp/SMS via Twilio",
    },
    capabilities: {
        chatTypes: ["dm", "thread"] as any, // Cast to any to resolve strict type mismatch
        media: true,
    },
    config: {
        listAccountIds: (cfg: MoltbotConfig) => ["default"],
        resolveAccount: (cfg: MoltbotConfig) => ({
            accountSid: (cfg.channels as any)?.["twilio-messaging"]?.accountSid,
            authToken: (cfg.channels as any)?.["twilio-messaging"]?.authToken,
            phoneNumber: (cfg.channels as any)?.["twilio-messaging"]?.phoneNumber,
        }),
    },
    register(api: any) {
        const logger = api.logger;
        const config = api.config as MoltbotConfig;

        // Initialize services
        const client = new TwilioClient(config);
        const handler = createTwilioWebhookHandler(client, logger);

        // Register webhook route
        // Note: The specific route path depends on how extensions register routes in Moltbot.
        // Assuming api.registerRoute or similar, or we might need to hook into the main server.
        // references extensions/voice-call/src/webhook.ts for pattern.

        // For now, we'll assume the main app will load this and we might need to expose the handler.
        // API surface area for extensions seems to be evolving, sticking to the standard ChannelPlugin shape.
    }
};

export default twilioMessagingPlugin;
