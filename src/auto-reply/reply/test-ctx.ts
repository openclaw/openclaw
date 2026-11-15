// Builds minimal message contexts for reply unit tests.
import type { FinalizedRuntimeMsgContext, MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";

export function buildTestCtx(overrides: Partial<MsgContext> = {}): FinalizedRuntimeMsgContext {
  return finalizeInboundContext({
    Body: "",
    CommandBody: "",
    CommandSource: "text",
    From: "whatsapp:+1000",
    To: "whatsapp:+2000",
    ChatType: "direct",
    Provider: "whatsapp",
    Surface: "whatsapp",
    CommandAuthorized: false,
    ...overrides,
  });
}

export function createRoutedTestCtx(
  channel: string,
  to: string,
  overrides: Parameters<typeof buildTestCtx>[0],
) {
  return buildTestCtx({
    Provider: channel,
    Surface: channel,
    OriginatingChannel: channel,
    OriginatingTo: to,
    To: to,
    AccountId: "default",
    ...overrides,
  });
}

export function createDiscordPluginBindingCtx(overrides: Parameters<typeof buildTestCtx>[0]) {
  return createRoutedTestCtx("discord", "discord:channel:1481858418548412579", {
    SenderId: "user-9",
    SenderUsername: "ada",
    CommandAuthorized: true,
    WasMentioned: false,
    CommandBody: "who are you",
    RawBody: "who are you",
    Body: "who are you",
    SessionKey: "agent:main:discord:channel:1481858418548412579",
    ...overrides,
  });
}

export function createRemoteImessageMediaCtx(to: string, messageId: string, rawPath: string) {
  return createRoutedTestCtx("imessage", to, {
    SenderId: "user-9",
    CommandAuthorized: true,
    WasMentioned: false,
    CommandBody: "what is this?",
    RawBody: "what is this?",
    Body: "what is this?",
    MessageSid: messageId,
    SessionKey: "agent:main:imessage:direct:user",
    media: [{ path: rawPath, url: rawPath, contentType: "image/jpeg" }],
    MediaRemoteHost: "user@gateway-host",
  });
}
