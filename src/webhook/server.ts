/* istanbul ignore file */
import { startWebhook } from "../twilio/webhook.js";

// Thin wrapper to keep webhook server co-located with other webhook helpers.
export { startWebhook };

export type WebhookServer = Awaited<ReturnType<typeof startWebhook>>;
