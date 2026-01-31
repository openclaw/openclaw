import { logInfo, logError } from "../../logger.js";

const CONFIG = {
  apiKey: process.env.TERMII_API_KEY || "",
  senderId: process.env.TERMII_SENDER_ID || "Termii",
  baseUrl: process.env.TERMII_BASE_URL || "https://api.ng.termii.com",
};

export const NIGERIAN_CARRIERS: Record<string, string[]> = {
  MTN: ["803", "806", "703", "706", "813", "816", "810", "814", "903", "906"],
  GLO: ["805", "807", "705", "815", "811", "905"],
  AIRTEL: ["802", "808", "708", "812", "701", "902", "901"],
  "9MOBILE": ["809", "817", "818", "909", "908"],
};

export function validateNigerianNumber(number: string): { isValid: boolean; formatted: string; carrier?: string; error?: string } {
  if (!number) return { isValid: false, formatted: "", error: "Phone number required" };
  let cleaned = number.replace(/\D/g, "");
  if (cleaned.startsWith("0")) cleaned = "234" + cleaned.substring(1);
  else if (cleaned.length === 10) cleaned = "234" + cleaned;
  if (cleaned.length !== 13 || !cleaned.startsWith("234")) {
    return { isValid: false, formatted: cleaned, error: "Invalid Nigerian number" };
  }
  const prefix = cleaned.substring(3, 6);
  let carrier: string | undefined;
  for (const [name, prefixes] of Object.entries(NIGERIAN_CARRIERS)) {
    if (prefixes.includes(prefix)) { carrier = name; break; }
  }
  return carrier ? { isValid: true, formatted: cleaned, carrier } : { isValid: false, formatted: cleaned, error: "Unknown carrier" };
}

export async function sendSMS(to: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  if (!validation.isValid) return { success: false, error: validation.error };
  try {
    const response = await fetch(`${CONFIG.baseUrl}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: CONFIG.apiKey, to: validation.formatted, from: CONFIG.senderId, sms: message, type: "plain", channel: "generic" }),
    });
    const data = await response.json() as { message_id?: string };
    logInfo(`SMS sent to ${validation.formatted}`);
    return { success: true, messageId: data.message_id };
  } catch (error) {
    logError(`SMS failed: ${String(error)}`);
    return { success: false, error: String(error) };
  }
}

export async function sendBulkSMS(recipients: string[], message: string): Promise<{ success: boolean; error?: string }> {
  const valid = recipients.map(r => validateNigerianNumber(r)).filter(v => v.isValid).map(v => v.formatted);
  if (valid.length === 0) return { success: false, error: "No valid numbers" };
  try {
    await fetch(`${CONFIG.baseUrl}/api/sms/send/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: CONFIG.apiKey, to: valid, from: CONFIG.senderId, sms: message, type: "plain", channel: "generic" }),
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function sendVoiceOTP(to: string, code: string): Promise<{ success: boolean; pinId?: string; error?: string }> {
  const validation = validateNigerianNumber(to);
  if (!validation.isValid) return { success: false, error: validation.error };
  try {
    const response = await fetch(`${CONFIG.baseUrl}/api/sms/otp/send/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: CONFIG.apiKey, phone_number: validation.formatted, code }),
    });
    const data = await response.json() as { pinId?: string };
    return { success: true, pinId: data.pinId };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getBalance(): Promise<{ success: boolean; balance?: number; error?: string }> {
  try {
    const response = await fetch(`${CONFIG.baseUrl}/api/get-balance?api_key=${CONFIG.apiKey}`);
    const data = await response.json() as { balance?: number };
    return { success: true, balance: data.balance };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
