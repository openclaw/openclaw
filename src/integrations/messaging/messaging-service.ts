import { logInfo } from "../../logger.js";
import { sendSMS, sendVoiceOTP } from "../termii/termii-service.js";
import { sendTextMessage, sendButtonMessage } from "../whatsapp/whatsapp-service.js";

export type MessageChannel = "whatsapp" | "sms" | "voice";

const userPreferences = new Map<string, MessageChannel>();
const conversationHistory = new Map<string, { content: string; timestamp: Date; direction: string }[]>();

export function setUserPreferredChannel(userId: string, channel: MessageChannel): void {
  userPreferences.set(userId, channel);
}

export function getUserPreferredChannel(userId: string): MessageChannel | undefined {
  return userPreferences.get(userId);
}

export async function sendMessage(userId: string, message: string, options?: { channel?: MessageChannel }): Promise<{ success: boolean; channel?: MessageChannel; error?: string }> {
  const channel = options?.channel || getUserPreferredChannel(userId) || "whatsapp";
  logInfo(`Sending message to ${userId} via ${channel}`);
  
  let result: { success: boolean; error?: string };
  switch (channel) {
    case "whatsapp":
      result = await sendTextMessage(userId, message);
      break;
    case "sms":
      result = await sendSMS(userId, message);
      break;
    case "voice":
      result = await sendVoiceOTP(userId, message);
      break;
    default:
      result = { success: false, error: "Unknown channel" };
  }

  if (result.success) {
    recordMessage(userId, channel, message, "outbound");
  } else if (!options?.channel) {
    // Fallback to SMS if WhatsApp fails
    if (channel === "whatsapp") {
      logInfo(`WhatsApp failed, falling back to SMS`);
      return sendMessage(userId, message, { channel: "sms" });
    }
  }

  return { ...result, channel };
}

export async function sendNotification(userId: string, notification: { type: string; data: { body: string; title?: string } }): Promise<{ success: boolean; channel?: MessageChannel }> {
  const message = notification.data.title ? `${notification.data.title}\n\n${notification.data.body}` : notification.data.body;
  const channel: MessageChannel = notification.type === "otp" ? "voice" : "whatsapp";
  return sendMessage(userId, message, { channel });
}

export async function broadcastMessage(userIds: string[], message: string): Promise<{ totalSent: number; totalFailed: number }> {
  let totalSent = 0, totalFailed = 0;
  for (const userId of userIds) {
    const result = await sendMessage(userId, message);
    result.success ? totalSent++ : totalFailed++;
  }
  return { totalSent, totalFailed };
}

function recordMessage(userId: string, channel: MessageChannel, content: string, direction: string): void {
  const key = `${userId}:${channel}`;
  const history = conversationHistory.get(key) || [];
  history.push({ content, timestamp: new Date(), direction });
  if (history.length > 50) history.shift();
  conversationHistory.set(key, history);
}

export function getConversationHistory(userId: string, channel: MessageChannel, limit = 20): { content: string; timestamp: Date; direction: string }[] {
  const key = `${userId}:${channel}`;
  const history = conversationHistory.get(key) || [];
  return history.slice(-limit);
}

export function clearConversationHistory(userId: string, channel?: MessageChannel): void {
  if (channel) {
    conversationHistory.delete(`${userId}:${channel}`);
  } else {
    for (const ch of ["whatsapp", "sms", "voice"] as MessageChannel[]) {
      conversationHistory.delete(`${userId}:${ch}`);
    }
  }
}

export function recordInboundMessage(userId: string, channel: MessageChannel, content: string): void {
  recordMessage(userId, channel, content, "inbound");
}
