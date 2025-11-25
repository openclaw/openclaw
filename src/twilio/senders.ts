import { danger, info, isVerbose, logVerbose } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { withWhatsAppPrefix } from "../utils.js";
import type { TwilioSenderListClient } from "./types.js";

export async function findWhatsappSenderSid(
  client: TwilioSenderListClient,
  from: string,
  explicitSenderSid?: string,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Use explicit sender SID if provided, otherwise list and match by sender_id.
  if (explicitSenderSid) {
    logVerbose(`Using TWILIO_SENDER_SID from env: ${explicitSenderSid}`);
    return explicitSenderSid;
  }
  try {
    // Prefer official SDK list helper to avoid request-shape mismatches.
    // Twilio helper types are broad; we narrow to expected shape.
    const senderClient = client as unknown as TwilioSenderListClient;
    const senders = await senderClient.messaging.v2.channelsSenders.list({
      channel: "whatsapp",
      pageSize: 50,
    });
    if (!senders) {
      throw new Error('List senders response missing "senders" array');
    }
    const match = senders.find(
      (s) =>
        (typeof s.senderId === "string" &&
          s.senderId === withWhatsAppPrefix(from)) ||
        (typeof s.sender_id === "string" &&
          s.sender_id === withWhatsAppPrefix(from)),
    );
    if (!match || typeof match.sid !== "string") {
      throw new Error(
        `Could not find sender ${withWhatsAppPrefix(from)} in Twilio account`,
      );
    }
    return match.sid;
  } catch (err) {
    runtime.error(danger("Unable to list WhatsApp senders via Twilio API."));
    if (isVerbose()) {
      runtime.error(err as Error);
    }
    runtime.error(
      info(
        "Set TWILIO_SENDER_SID in .env to skip discovery (Twilio Console → Messaging → Senders → WhatsApp).",
      ),
    );
    runtime.exit(1);
  }
}
