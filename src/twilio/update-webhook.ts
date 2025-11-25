import { readEnv } from "../env.js";
import { isVerbose } from "../globals.js";
import { logError, logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { createClient } from "./client.js";
import type { TwilioRequester, TwilioSenderListClient } from "./types.js";

export async function findIncomingNumberSid(
  client: TwilioSenderListClient,
): Promise<string | null> {
  // Look up incoming phone number SID matching the configured WhatsApp number.
  try {
    const env = readEnv();
    const phone = env.whatsappFrom.replace("whatsapp:", "");
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: phone,
      limit: 1,
    });
    return list?.[0]?.sid ?? null;
  } catch {
    return null;
  }
}

export async function findMessagingServiceSid(
  client: TwilioSenderListClient,
): Promise<string | null> {
  // Attempt to locate a messaging service tied to the WA phone number (webhook fallback).
  type IncomingNumberWithService = { messagingServiceSid?: string };
  try {
    const env = readEnv();
    const phone = env.whatsappFrom.replace("whatsapp:", "");
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: phone,
      limit: 1,
    });
    const msid =
      (list?.[0] as IncomingNumberWithService | undefined)
        ?.messagingServiceSid ?? null;
    return msid;
  } catch {
    return null;
  }
}

export async function setMessagingServiceWebhook(
  client: TwilioSenderListClient,
  url: string,
  method: "POST" | "GET",
  runtime: RuntimeEnv = defaultRuntime,
): Promise<boolean> {
  const msid = await findMessagingServiceSid(client);
  if (!msid) return false;
  try {
    await client.messaging.v1.services(msid).update({
      InboundRequestUrl: url,
      InboundRequestMethod: method,
    });
    const fetched = await client.messaging.v1.services(msid).fetch();
    const stored = fetched?.inboundRequestUrl;
    logInfo(
      `✅ Messaging Service webhook set to ${stored ?? url} (service ${msid})`,
      runtime,
    );
    return true;
  } catch {
    return false;
  }
}

// Update sender webhook URL with layered fallbacks (channels, form, helper, phone).
export async function updateWebhook(
  client: ReturnType<typeof createClient>,
  senderSid: string,
  url: string,
  method: "POST" | "GET" = "POST",
  runtime: RuntimeEnv,
) {
  // Point Twilio sender webhook at the provided URL.
  const requester = client as unknown as TwilioRequester;
  const clientTyped = client as unknown as TwilioSenderListClient;

  // 1) Raw request (Channels/Senders) with JSON webhook payload — most reliable for WA
  try {
    await requester.request({
      method: "post",
      uri: `https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`,
      body: {
        webhook: {
          callback_url: url,
          callback_method: method,
        },
      },
      contentType: "application/json",
    });
    const fetched = await clientTyped.messaging.v2
      .channelsSenders(senderSid)
      .fetch();
    const storedUrl =
      fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
    if (storedUrl) {
      logInfo(`✅ Twilio sender webhook set to ${storedUrl}`, runtime);
      return;
    }
    if (isVerbose())
      logError(
        "Sender updated but webhook callback_url missing; will try fallbacks",
        runtime,
      );
  } catch (err) {
    if (isVerbose())
      logError(
        `channelsSenders request update failed, will try client helpers: ${String(err)}`,
        runtime,
      );
  }

  // 1b) Form-encoded fallback for older Twilio stacks
  try {
    await requester.request({
      method: "post",
      uri: `https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`,
      form: {
        "Webhook.CallbackUrl": url,
        "Webhook.CallbackMethod": method,
      },
    });
    const fetched = await clientTyped.messaging.v2
      .channelsSenders(senderSid)
      .fetch();
    const storedUrl =
      fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
    if (storedUrl) {
      logInfo(`✅ Twilio sender webhook set to ${storedUrl}`, runtime);
      return;
    }
    if (isVerbose())
      logError(
        "Form update succeeded but callback_url missing; will try helper fallback",
        runtime,
      );
  } catch (err) {
    if (isVerbose())
      logError(
        `Form channelsSenders update failed, will try helper fallback: ${String(err)}`,
        runtime,
      );
  }

  // 2) SDK helper fallback (if supported by this client)
  try {
    if (clientTyped.messaging?.v2?.channelsSenders) {
      await clientTyped.messaging.v2.channelsSenders(senderSid).update({
        callbackUrl: url,
        callbackMethod: method,
      });
      const fetched = await clientTyped.messaging.v2
        .channelsSenders(senderSid)
        .fetch();
      const storedUrl =
        fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
      logInfo(
        `✅ Twilio sender webhook set to ${storedUrl ?? url} (helper API)`,
        runtime,
      );
      return;
    }
  } catch (err) {
    if (isVerbose())
      logError(
        `channelsSenders helper update failed, will try phone number fallback: ${String(err)}`,
        runtime,
      );
  }

  // 3) Incoming phone number fallback (works for many WA senders)
  try {
    const phoneSid = await findIncomingNumberSid(clientTyped);
    if (phoneSid) {
      await clientTyped.incomingPhoneNumbers(phoneSid).update({
        smsUrl: url,
        smsMethod: method,
      });
      logInfo(`✅ Phone webhook set to ${url} (number ${phoneSid})`, runtime);
      return;
    }
  } catch (err) {
    if (isVerbose())
      logError(
        `Incoming phone number webhook update failed; no more fallbacks: ${String(err)}`,
        runtime,
      );
  }

  runtime.error(
    `❌ Failed to update Twilio webhook for sender ${senderSid} after multiple attempts`,
  );
}
