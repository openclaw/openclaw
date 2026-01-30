import type { ChannelLogSink } from "../../../channels/plugins/types.core.js";
import { TwilioClient } from "./client.js";
import { processVoicePipeline } from "./voice-pipeline.js";

export interface TwilioWebhookHandler {
    handleRequest(req: any, res: any): Promise<void>;
}

export function createTwilioWebhookHandler(
    client: TwilioClient,
    logger: ChannelLogSink
): TwilioWebhookHandler {
    return {
        async handleRequest(req, res) {
            try {
                const { Body, From, To, MediaUrl0, MediaContentType0 } = req.body;

                logger.info(`[Twilio] Received message from ${From}: ${Body || (MediaUrl0 ? "<Media>" : "<Empty>")}`);

                // Handle Audio/Voice
                if (MediaContentType0 && MediaContentType0.startsWith("audio/")) {
                    logger.info(`[Twilio] Processing audio from ${From}`);
                    await processVoicePipeline({
                        mediaUrl: MediaUrl0,
                        from: From,
                        to: To,
                        client,
                        logger
                    });
                    res.status(200).send("<Response></Response>"); // Ack
                    return;
                }

                // Handle Text
                if (Body) {
                    // TODO: Integrate with Ollama chat loop (text-only path)
                    // For now, simple echo or ack
                    // await client.sendMessage(From, `Echo: ${Body}`);

                    // In real implementation, this should inject into Moltbot's central chat loop
                    // via api.injectMessage or similar mechanism found in channel-web.
                }

                res.status(200).send("<Response></Response>");
            } catch (err) {
                logger.error(`[Twilio] Error handling webhook: ${err}`);
                res.status(500).send("Internal Server Error");
            }
        }
    };
}
