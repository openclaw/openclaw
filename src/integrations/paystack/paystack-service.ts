import crypto from "node:crypto";
import { logInfo, logError } from "../../logger.js";

const CONFIG = {
  secretKey: process.env.PAYSTACK_SECRET_KEY || "",
  publicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
  webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || "",
  baseUrl: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
};

export function nairaToKobo(naira: number): number { return Math.round(naira * 100); }
export function koboToNaira(kobo: number): number { return kobo / 100; }
export function generateReference(prefix = "TXN"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`.toUpperCase();
}

async function paystackRequest<T>(endpoint: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${CONFIG.baseUrl}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${CONFIG.secretKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as { status: boolean; data: T; message?: string };
  if (!data.status) throw new Error(data.message || "Paystack API error");
  return data.data;
}

export async function initializePayment(options: { email: string; amount: number; callbackUrl?: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; authorizationUrl?: string; reference?: string; error?: string }> {
  try {
    const reference = generateReference("PAY");
    const data = await paystackRequest<{ authorization_url: string; reference: string }>("/transaction/initialize", "POST", {
      email: options.email, amount: nairaToKobo(options.amount), reference, callback_url: options.callbackUrl, metadata: options.metadata,
    });
    logInfo(`Payment initialized: ${reference}`);
    return { success: true, authorizationUrl: data.authorization_url, reference: data.reference };
  } catch (error) {
    logError(`Payment init failed: ${String(error)}`);
    return { success: false, error: String(error) };
  }
}

export async function verifyPayment(reference: string): Promise<{ success: boolean; status?: string; amount?: number; error?: string }> {
  try {
    const data = await paystackRequest<{ status: string; amount: number }>(`/transaction/verify/${encodeURIComponent(reference)}`, "GET");
    return { success: true, status: data.status, amount: koboToNaira(data.amount) };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function listBanks(): Promise<{ success: boolean; banks?: { name: string; code: string }[]; error?: string }> {
  try {
    const banks = await paystackRequest<{ name: string; code: string }[]>("/bank?country=nigeria", "GET");
    return { success: true, banks };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function createTransferRecipient(options: { name: string; accountNumber: string; bankCode: string }): Promise<{ success: boolean; recipientCode?: string; error?: string }> {
  try {
    const data = await paystackRequest<{ recipient_code: string }>("/transferrecipient", "POST", {
      type: "nuban", name: options.name, account_number: options.accountNumber, bank_code: options.bankCode, currency: "NGN",
    });
    return { success: true, recipientCode: data.recipient_code };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function initiateTransfer(options: { amount: number; recipientCode: string; reason?: string }): Promise<{ success: boolean; transferCode?: string; error?: string }> {
  try {
    const data = await paystackRequest<{ transfer_code: string }>("/transfer", "POST", {
      source: "balance", amount: nairaToKobo(options.amount), recipient: options.recipientCode, reason: options.reason || "Payout",
    });
    return { success: true, transferCode: data.transfer_code };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function verifyWebhookSignature(payload: string, signature: string): boolean {
  const hash = crypto.createHmac("sha512", CONFIG.webhookSecret).update(payload).digest("hex");
  return hash === signature;
}

export async function handleWebhook(payload: string, signature: string): Promise<{ success: boolean; event?: { event: string; data: unknown }; error?: string }> {
  if (!verifyWebhookSignature(payload, signature)) return { success: false, error: "Invalid signature" };
  try {
    const event = JSON.parse(payload) as { event: string; data: unknown };
    logInfo(`Paystack webhook: ${event.event}`);
    return { success: true, event };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
