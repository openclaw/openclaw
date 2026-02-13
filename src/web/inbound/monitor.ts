import type {
  AnyMessageContent,
  Contact,
  GroupMetadata,
  proto,
  WAMessage,
} from "@whiskeysockets/baileys";
import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { formatLocationText } from "../../channels/location.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { getChildLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { jidToE164, resolveJidToE164 } from "../../utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { WhatsAppMessageStore, type StoredMessage } from "../whatsapp-message-store.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional message store instance. */
  messageStore?: WhatsAppMessageStore | null;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();

  // Trigger app state resync immediately after connection is established.
  // We do this here (not in connection.update handler) because the "open" event
  // fires during waitForWaConnection and is already consumed by the time
  // we register our connection.update listener below.
  if (options.messageStore) {
    void (async () => {
      try {
        logVerbose("[WA contacts] Triggering full app state resync for contacts...");
        await sock.resyncAppState(
          ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"],
          false,
        );
        logVerbose("[WA contacts] App state resync completed");
      } catch (err) {
        logVerbose(`[WA contacts] App state resync failed (non-critical): ${String(err)}`);
      }
    })();
  }

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey =
        msg.chatType === "group"
          ? (msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const id = msg.key?.id ?? undefined;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) {
        continue;
      }
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
        continue;
      }

      const group = isJidGroup(remoteJid) === true;
      if (id) {
        const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
        if (isRecentInboundMessage(dedupeKey)) {
          continue;
        }
      }
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : await resolveInboundJid(remoteJid);
      if (!from) {
        continue;
      }
      const senderE164 = group
        ? participantJid
          ? await resolveInboundJid(participantJid)
          : null
        : from;

      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
      }
      const messageTimestampMs = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      // Store message BEFORE policy checks (for history/search)
      const messageText = extractText(msg.message ?? undefined);
      if (messageText && options.messageStore) {
        const storedMsg: StoredMessage = {
          id,
          chatJid: remoteJid,
          senderJid: participantJid,
          text: messageText,
          timestamp: messageTimestampMs ?? Date.now(),
          fromMe: Boolean(msg.key?.fromMe),
          pushName: msg.pushName ?? undefined,
          type: "text", // simplified for now
        };
        options.messageStore.storeMessage(storedMsg);
      }

      const access = await checkInboundAccessControl({
        accountId: options.accountId,
        from,
        selfE164,
        senderE164,
        group,
        pushName: msg.pushName ?? undefined,
        isFromMe: Boolean(msg.key?.fromMe),
        messageTimestampMs,
        connectedAtMs,
        sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
        remoteJid,
      });
      if (!access.allowed) {
        continue;
      }

      if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([{ remoteJid, id, participant, fromMe: false }]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && access.isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        continue;
      }

      const location = extractLocationData(msg.message ?? undefined);
      const locationText = location ? formatLocationText(location) : undefined;
      let body = extractText(msg.message ?? undefined);
      if (locationText) {
        body = [body, locationText].filter(Boolean).join("\n").trim();
      }
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) {
          continue;
        }
      }
      const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let mediaFileName: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
        if (inboundMedia) {
          const maxMb =
            typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
              ? options.mediaMaxMb
              : 50;
          const maxBytes = maxMb * 1024 * 1024;
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
            "inbound",
            maxBytes,
            inboundMedia.fileName,
          );
          mediaPath = saved.path;
          mediaType = inboundMedia.mimetype;
          mediaFileName = inboundMedia.fileName;
        }
      } catch (err) {
        logVerbose(`Inbound media download failed: ${String(err)}`);
      }

      const chatJid = remoteJid;
      const sendComposing = async () => {
        try {
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch (err) {
          logVerbose(`Presence update failed: ${String(err)}`);
        }
      };
      const reply = async (text: string) => {
        await sock.sendMessage(chatJid, { text });
      };
      const sendMedia = async (payload: AnyMessageContent) => {
        await sock.sendMessage(chatJid, payload);
      };
      const timestamp = messageTimestampMs;
      const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
      const senderName = msg.pushName ?? undefined;

      inboundLogger.info(
        { from, to: selfE164 ?? "me", body, mediaPath, mediaType, mediaFileName, timestamp },
        "inbound message",
      );
      const inboundMessage: WebInboundMessage = {
        id,
        from,
        conversationId: from,
        to: selfE164 ?? "me",
        accountId: access.resolvedAccountId,
        body,
        pushName: senderName,
        timestamp,
        chatType: group ? "group" : "direct",
        chatId: remoteJid,
        senderJid: participantJid,
        senderE164: senderE164 ?? undefined,
        senderName,
        replyToId: replyContext?.id,
        replyToBody: replyContext?.body,
        replyToSender: replyContext?.sender,
        replyToSenderJid: replyContext?.senderJid,
        replyToSenderE164: replyContext?.senderE164,
        groupSubject,
        groupParticipants,
        mentionedJids: mentionedJids ?? undefined,
        selfJid,
        selfE164,
        location: location ?? undefined,
        sendComposing,
        reply,
        sendMedia,
        mediaPath,
        mediaType,
        mediaFileName,
      };
      try {
        const task = Promise.resolve(debouncer.enqueue(inboundMessage));
        void task.catch((err) => {
          inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
          inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      }
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);

  // Sync message history on connection — WhatsApp sends historical messages
  // via "messaging-history.set" when the device reconnects
  // Only register this listener if message store is enabled
  if (options.messageStore) {
    sock.ev.on(
      "messaging-history.set",
      (data: {
        messages?: Array<WAMessage>;
        chats?: unknown[];
        contacts?: unknown[];
        isLatest?: boolean;
      }) => {
        const msgs = data.messages ?? [];
        let stored = 0;
        for (const msg of msgs) {
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid || remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
            continue;
          }
          const text = extractText(msg.message ?? undefined);
          if (!text) {
            continue;
          }
          const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
          if (options.messageStore) {
            options.messageStore.storeMessage({
              id: msg.key?.id ?? undefined,
              chatJid: remoteJid,
              senderJid: msg.key?.participant ?? undefined,
              text,
              timestamp: ts,
              fromMe: Boolean(msg.key?.fromMe),
              pushName: msg.pushName ?? undefined,
              type: "text",
            });
            stored++;
          }
        }
        if (stored > 0) {
          logVerbose(
            `[WA history sync] Stored ${stored} messages from ${msgs.length} total (isLatest: ${data.isLatest})`,
          );
        }

        // Extract contact names from history sync
        const syncContacts = (data.contacts ?? []) as Array<{
          id?: string;
          name?: string;
          notify?: string;
          verifiedName?: string;
        }>;
        let contactsAdded = 0;
        for (const contact of syncContacts) {
          if (!contact.id) {
            continue;
          }
          const displayName = contact.verifiedName ?? contact.notify ?? contact.name;
          if (displayName && options.messageStore) {
            options.messageStore.updateContactName(contact.id, displayName);
            contactsAdded++;
          }
        }
        if (contactsAdded > 0) {
          logVerbose(`[WA history sync] Added ${contactsAdded} contact names`);
        }
      },
    );

    // Track contact names from Baileys contacts.upsert event
    // This fires from app state sync (resyncAppState) with fullName + lidJid + pnJid
    sock.ev.on("contacts.upsert", (contacts: Partial<Contact>[]) => {
      let updated = 0;
      for (const contact of contacts) {
        if (!contact.id) {
          continue;
        }
        // Use the best available name: verifiedName > notify > name
        const displayName = contact.verifiedName ?? contact.notify ?? contact.name;
        if (displayName && options.messageStore) {
          options.messageStore.updateContactName(contact.id, displayName);
          // Also store under LID and phone number for cross-referencing
          const contactAny = contact as Record<string, unknown>;
          const lid = contactAny.lid as string | undefined;
          const phoneNumber = contactAny.phoneNumber as string | undefined;
          if (lid && typeof lid === "string") {
            options.messageStore.updateContactName(lid, displayName);
            options.messageStore.addJidMapping(lid, contact.id);
          }
          if (phoneNumber && typeof phoneNumber === "string") {
            options.messageStore.addJidMapping(phoneNumber, contact.id);
          }
          updated++;
        }
      }
      if (updated > 0) {
        logVerbose(
          `[WA contacts] Added/updated ${updated} contact names from contacts.upsert (total batch: ${contacts.length})`,
        );
      }
    });

    // Track contact name updates from Baileys contacts.update event
    sock.ev.on("contacts.update", (contacts: Partial<Contact>[]) => {
      let updated = 0;
      for (const contact of contacts) {
        if (!contact.id) {
          continue;
        }
        const displayName = contact.verifiedName ?? contact.notify ?? contact.name;
        if (displayName && options.messageStore) {
          options.messageStore.updateContactName(contact.id, displayName);
          updated++;
        }
      }
      if (updated > 0) {
        logVerbose(`[WA contacts] Updated ${updated} contact names`);
      }
    });
  }

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === DisconnectReason.loggedOut,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid?: string) => sock.sendPresenceUpdate(presence, jid),
    },
    defaultAccountId: options.accountId,
    messageStore: options.messageStore,
  });

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const messagesUpsertHandler = handleMessagesUpsert as unknown as (
          ...args: unknown[]
        ) => void;
        const connectionUpdateHandler = handleConnectionUpdate as unknown as (
          ...args: unknown[]
        ) => void;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
    // Message history and retrieval methods (only if store is enabled)
    ...(options.messageStore
      ? {
          fetchMessageHistory: async (chatJid: string, count: number): Promise<void> => {
            // Get the oldest message from the store to use as a starting point
            const existingMessages = options.messageStore!.getMessages(chatJid);
            if (existingMessages.length > 0) {
              const oldestMsg = existingMessages[0];
              const timestamp = oldestMsg.timestamp || Date.now();
              await sock.fetchMessageHistory(
                count,
                { remoteJid: chatJid, id: oldestMsg.id || "", fromMe: oldestMsg.fromMe },
                timestamp,
              );
            } else {
              // If no messages in store, fetch from current time
              await sock.fetchMessageHistory(
                count,
                { remoteJid: chatJid, id: "", fromMe: false },
                Date.now(),
              );
            }
          },
          getMessages: async (chatJid: string, limit?: number): Promise<StoredMessage[]> => {
            return options.messageStore!.getMessages(chatJid, limit);
          },
          searchMessages: async (
            query: string,
            chatJid?: string,
            limit?: number,
          ): Promise<StoredMessage[]> => {
            return options.messageStore!.searchMessages(query, chatJid, limit);
          },
          listChats: async () => {
            return options.messageStore!.listChats();
          },
          getContactName: (jid: string): string | undefined => {
            return options.messageStore!.getContactName(jid);
          },
          setContactName: (jid: string, name: string): void => {
            options.messageStore!.setContactName(jid, name);
          },
          resolveContactByName: (query: string): Array<{ jid: string; name: string }> => {
            return options.messageStore!.resolveContactByName(query);
          },
        }
      : {}),
    fetchAllGroups: async () => {
      try {
        const groups = await sock.groupFetchAllParticipating();
        return Object.values(groups).map((g: GroupMetadata) => ({
          jid: g.id,
          subject: g.subject ?? "Unknown",
          participants: g.participants?.length ?? 0,
        }));
      } catch (err) {
        logVerbose(`Failed to fetch groups: ${String(err)}`);
        return [];
      }
    },
  } as const;
}
