import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { requireActiveWebListener } from "../../web/active-listener.js";
import { sendReactionWhatsApp } from "../../web/outbound.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
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

  if (action === "getMessages") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.getMessages) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    const chatJid =
      readStringParam(params, "chatJid") || readStringParam(params, "target", { required: true });
    const limitRaw = params.limit;
    const limit = typeof limitRaw === "number" ? limitRaw : 20;

    // Auto-fetch from WhatsApp servers if store has fewer messages than requested
    let messages = await listener.getMessages(chatJid, limit);
    if (messages.length < limit && listener.fetchMessageHistory) {
      const fetchCount = Math.max(limit, 50);
      await listener.fetchMessageHistory(chatJid, fetchCount);
      // Wait for messages to arrive via upsert (WhatsApp delivers async)
      await new Promise((resolve) => setTimeout(resolve, 3000));
      messages = await listener.getMessages(chatJid, limit);
    }

    return jsonResult({ ok: true, messages, count: messages.length });
  }

  if (action === "searchMessages") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.searchMessages) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const chatJid = readStringParam(params, "chatJid");

    // If searching a specific chat with no messages, auto-fetch first
    if (chatJid && listener.getMessages && listener.fetchMessageHistory) {
      const existing = await listener.getMessages(chatJid);
      if (existing.length === 0) {
        await listener.fetchMessageHistory(chatJid, 100);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    const limitRaw = params.limit;
    const searchLimit = typeof limitRaw === "number" ? limitRaw : 100;
    const messages = await listener.searchMessages(query, chatJid, searchLimit);
    return jsonResult({ ok: true, messages, count: messages.length });
  }

  if (action === "listChats") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.listChats) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    // Merge store chats with live groups from WhatsApp
    const storeChats = await listener.listChats();
    const groups = listener.fetchAllGroups ? await listener.fetchAllGroups() : [];
    const storeJids = new Set(storeChats.map((c) => c.chatJid));
    const mergedChats = [...storeChats];
    for (const g of groups) {
      if (!storeJids.has(g.jid)) {
        mergedChats.push({
          chatJid: g.jid,
          lastMessage: undefined,
          messageCount: 0,
          groupSubject: g.subject,
          participants: g.participants,
        });
      } else {
        // Enrich existing store entry with group info
        const existing = mergedChats.find((c) => c.chatJid === g.jid);
        if (existing) {
          existing.groupSubject = g.subject;
          existing.participants = g.participants;
        }
      }
    }
    return jsonResult({ ok: true, chats: mergedChats, count: mergedChats.length });
  }

  if (action === "resolveContact") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.resolveContactByName) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const contacts = listener.resolveContactByName(query);
    return jsonResult({ ok: true, contacts, count: contacts.length });
  }

  if (action === "setContactName") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.setContactName) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    const rawTarget = readStringParam(params, "target", { required: true });
    // Normalize to JID if just a phone number
    const jid = rawTarget.includes("@")
      ? rawTarget
      : `${rawTarget.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
    const name = readStringParam(params, "name", { required: true });
    listener.setContactName(jid, name);
    return jsonResult({ ok: true, message: `Set contact name: ${jid} → ${name}` });
  }

  if (action === "fetchHistory") {
    const accountId = readStringParam(params, "accountId");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.fetchMessageHistory) {
      throw new Error(
        "WhatsApp message store is not enabled. Enable it in config: channels.whatsapp.messageStore.enabled = true",
      );
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const countRaw = params.count;
    const count = typeof countRaw === "number" ? countRaw : 50;
    // Capture message count before fetch to detect new arrivals
    const beforeCount = listener.getMessages ? (await listener.getMessages(chatJid)).length : 0;

    await listener.fetchMessageHistory(chatJid, count);

    // Wait for messages to arrive via messaging-history.set (WhatsApp delivers async)
    // Poll for up to 15 seconds checking if new messages appeared
    let afterCount = beforeCount;
    if (listener.getMessages) {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        afterCount = (await listener.getMessages(chatJid)).length;
        if (afterCount > beforeCount) {
          break;
        }
      }
    }

    const newMessages = afterCount - beforeCount;
    return jsonResult({
      ok: true,
      message: `Requested ${count} messages from ${chatJid}`,
      newMessagesReceived: newMessages,
      totalMessagesInStore: afterCount,
    });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
