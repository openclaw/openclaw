import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { sendReactionWhatsApp } from "../../web/outbound.js";
import { readFileWhatsApp } from "../../web/outbound.js";
import { readWhatsAppMessages } from "../../web/read-messages.js";
import { saveMediaBuffer } from "../../media/store.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("gateway/channels/whatsapp").child("actions");

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  log.info(`WhatsApp action invoked: ${action}`);
  const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const accountId = readStringParam(params, "accountId");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;
    const resolvedEmoji = remove ? "" : emoji;
    await sendReactionWhatsApp(chatJid, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: accountId ?? undefined,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "readFile") {
    if (!isActionEnabled("readFile")) {
      log.warn("WhatsApp readFile action is disabled in config");
      throw new Error("WhatsApp readFile is disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const accountId = readStringParam(params, "accountId");

    log.info(`Reading file from WhatsApp: chatJid=${chatJid}, messageId=${messageId}`);
    const result = await readFileWhatsApp(chatJid, messageId, {
      accountId: accountId ?? undefined,
    });

    if (!result) {
      return jsonResult({ ok: false, error: "Message not found or has no media" });
    }

    // Save the media buffer to a file
    const saved = await saveMediaBuffer(
      result.buffer,
      result.mimetype,
      "agent-download",
      50 * 1024 * 1024, // 50MB max
      result.fileName,
    );

    return jsonResult({
      ok: true,
      path: saved.path,
      mimetype: result.mimetype,
      fileName: result.fileName,
      size: result.buffer.length,
    });
  }

  if (action === "read") {
    if (!isActionEnabled("messages")) {
      log.warn("WhatsApp message reading action is disabled in config");
      throw new Error("WhatsApp message reading is disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const accountId = readStringParam(params, "accountId");
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const fetchHistory = typeof params.fetchHistory === "boolean" ? params.fetchHistory : true;

    log.info(
      `Reading messages from WhatsApp: chatJid=${chatJid}, limit=${limit ?? "default"}, fetchHistory=${fetchHistory}`,
    );

    // Check access control for the chat
    const { loadConfig } = await import("../../config/config.js");
    const { resolveWhatsAppAccount } = await import("../../web/accounts.js");
    const config = loadConfig();
    const account = resolveWhatsAppAccount({ cfg: config, accountId });
    
    // Check if chat is in allowChats list
    if (account.allowChats && account.allowChats.length > 0) {
      const chatAllowed = account.allowChats.includes(chatJid);
      if (!chatAllowed) {
        log.warn(`Access denied: chat ${chatJid} not in allowChats`);
        throw new Error(`Access denied: This chat is not in the allowed chats list.`);
      }
    }

    // Check message store stats
    const { getMessageStore } = await import("../../web/inbound/message-store.js");
    const messageStore = getMessageStore(accountId ?? "");
    const stats = messageStore.getStats();
    const storedChats = messageStore.getStoredChats();
    log.info(
      `Message store stats: totalMessages=${stats.totalMessages}, chatCount=${stats.chatCount}, storedChats=${JSON.stringify(storedChats)}`,
    );

    // First, try to get messages from the store
    let result = await readWhatsAppMessages(chatJid, {
      accountId: accountId ?? "",
      limit,
    });

    // If store is empty and fetchHistory is enabled, try to fetch from WhatsApp
    if (result.messages.length === 0 && fetchHistory) {
      log.info(`Message store empty for ${chatJid}, attempting to fetch history from WhatsApp`);
      try {
        const { requireActiveWebListener } = await import("../../web/active-listener.js");
        const { listener } = requireActiveWebListener(accountId);

        if (listener.fetchHistory) {
          log.info(`Calling listener.fetchHistory for ${chatJid} with limit ${limit ?? 50}`);
          const fetchResult = await listener.fetchHistory(chatJid, limit ?? 50);
          log.info(`History fetch completed: stored ${fetchResult.stored} messages`);

          // Try reading again after fetch
          if (fetchResult.stored > 0) {
            result = await readWhatsAppMessages(chatJid, {
              accountId: accountId ?? "",
              limit,
            });
          }
        } else {
          log.warn("fetchHistory not available on listener");
        }
      } catch (err) {
        log.warn(`History fetch failed: ${String(err)}`);
        // Continue with empty result rather than failing
      }
    }

    log.info(`Retrieved ${result.messages.length} messages from WhatsApp`);
    return jsonResult({
      ok: true,
      messages: result.messages,
      count: result.messages.length,
    });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
