import { logInfo, logError } from "../../logger.js";
import { validateNigerianNumber } from "../termii/termii-service.js";

const CONFIG = {
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  apiVersion: process.env.WHATSAPP_API_VERSION || "v17.0",
};

async function whatsappRequest<T>(endpoint: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  const url = `https://graph.facebook.com/${CONFIG.apiVersion}/${CONFIG.phoneNumberId}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${CONFIG.accessToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return await response.json() as T;
}

export async function sendTextMessage(to: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  const formattedTo = validation.isValid ? validation.formatted : to.replace(/\D/g, "");
  try {
    const data = await whatsappRequest<{ messages?: { id: string }[] }>("/messages", "POST", {
      messaging_product: "whatsapp", recipient_type: "individual", to: formattedTo, type: "text", text: { body: text },
    });
    logInfo(`WhatsApp sent to ${formattedTo}`);
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    logError(`WhatsApp failed: ${String(error)}`);
    return { success: false, error: String(error) };
  }
}

export async function sendTemplateMessage(to: string, templateName: string, languageCode = "en"): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  const formattedTo = validation.isValid ? validation.formatted : to.replace(/\D/g, "");
  try {
    const data = await whatsappRequest<{ messages?: { id: string }[] }>("/messages", "POST", {
      messaging_product: "whatsapp", to: formattedTo, type: "template", template: { name: templateName, language: { code: languageCode } },
    });
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  const formattedTo = validation.isValid ? validation.formatted : to.replace(/\D/g, "");
  try {
    const data = await whatsappRequest<{ messages?: { id: string }[] }>("/messages", "POST", {
      messaging_product: "whatsapp", to: formattedTo, type: "image", image: { link: imageUrl, caption },
    });
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function sendButtonMessage(to: string, bodyText: string, buttons: { id: string; title: string }[]): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  const formattedTo = validation.isValid ? validation.formatted : to.replace(/\D/g, "");
  try {
    const data = await whatsappRequest<{ messages?: { id: string }[] }>("/messages", "POST", {
      messaging_product: "whatsapp", to: formattedTo, type: "interactive",
      interactive: { type: "button", body: { text: bodyText }, action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: b })) } },
    });
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function markAsRead(messageId: string): Promise<{ success: boolean }> {
  try {
    await whatsappRequest("/messages", "POST", { messaging_product: "whatsapp", status: "read", message_id: messageId });
    return { success: true };
  } catch {
    return { success: false };
  }
}

export function verifyWebhookChallenge(mode: string, token: string, challenge: string): { success: boolean; challenge?: string; error?: string } {
  if (mode !== "subscribe") return { success: false, error: "Invalid mode" };
  if (token !== CONFIG.verifyToken) return { success: false, error: "Invalid token" };
  return { success: true, challenge };
}

export interface ParsedMessage { from: string; messageId: string; type: string; content: string; timestamp: Date }

export function parseWebhookPayload(payload: { entry?: { changes?: { value?: { messages?: { from: string; id: string; type: string; text?: { body: string }; timestamp: string }[] } }[] }[] }): { messages: ParsedMessage[] } {
  const messages: ParsedMessage[] = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        messages.push({
          from: msg.from, messageId: msg.id, type: msg.type, content: msg.text?.body || "", timestamp: new Date(parseInt(msg.timestamp) * 1000),
        });
      }
    }
  }
  return { messages };
}

export async function handleWebhook(payload: unknown): Promise<{ success: boolean; messages: ParsedMessage[] }> {
  const { messages } = parseWebhookPayload(payload as Parameters<typeof parseWebhookPayload>[0]);
  for (const msg of messages) logInfo(`WhatsApp received from ${msg.from}: ${msg.type}`);
  return { success: true, messages };
}
