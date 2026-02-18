import type { proto } from "@whiskeysockets/baileys";
import type { createWaSocket } from "./session.js";
import { logVerbose } from "../globals.js";
import { getMessageStore } from "./inbound/message-store.js";

/**
 * Fetch message history for a chat and populate the message store.
 * 
 * WhatsApp's multi-device protocol doesn't provide a direct API to fetch arbitrary
 * message history on demand. Instead, history syncing happens automatically when:
 * 1. The client first connects (initial sync)
 * 2. The client reconnects after being offline
 * 3. Messages arrive via the messages.upsert event with type "append"
 * 
 * This function attempts to use Baileys' internal fetchMessageHistory method if available,
 * but it may not work reliably for all chat types or in all situations.
 * 
 * For the most reliable history access:
 * - Let the gateway stay connected to receive automatic syncs
 * - Restart the gateway to trigger a fresh sync
 * - Use the message store which captures messages as they arrive
 */
export async function fetchAndStoreHistory(
  chatJid: string,
  accountId: string,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  options?: {
    limit?: number;
  },
): Promise<{ stored: number; total: number }> {
  const limit = options?.limit ?? 50;
  
  try {
    logVerbose(`Attempting to fetch history for ${chatJid} (limit: ${limit})`);
    
    // Check if Baileys exposes a fetchMessageHistory method
    // This is an internal method that may or may not be available
    const fetchMessageHistory = (sock as unknown as {
      fetchMessageHistory?: (
        jid: string,
        count: number,
        cursor?: { id: string; fromMe: boolean },
      ) => Promise<proto.IWebMessageInfo[]>;
    }).fetchMessageHistory;
    
    if (!fetchMessageHistory) {
      logVerbose(
        "fetchMessageHistory method not available on socket. " +
        "History fetching is limited in WhatsApp's multi-device protocol. " +
        "Messages will be available as they arrive or after gateway restart.",
      );
      return { stored: 0, total: 0 };
    }

    logVerbose(`fetchMessageHistory method found, calling with jid=${chatJid}, count=${limit}`);
    
    // Attempt to fetch messages using the internal method
    const result = await fetchMessageHistory(chatJid, limit);
    
    logVerbose(`fetchMessageHistory returned result with type: ${typeof result}, isArray: ${Array.isArray(result)}`);
    
    // The result might be wrapped - check if it's an array of arrays
    let messages: proto.IWebMessageInfo[];
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      logVerbose(`Result is a nested array, unwrapping first element`);
      messages = result[0] as proto.IWebMessageInfo[];
    } else if (Array.isArray(result)) {
      messages = result as proto.IWebMessageInfo[];
    } else {
      const resultStr = typeof result === "string" ? result : JSON.stringify(result).slice(0, 200);
      logVerbose(`Unexpected result type from fetchMessageHistory: ${typeof result}. Content: ${resultStr}`);
      return { stored: 0, total: 0 };
    }
    
    logVerbose(`Processing ${messages?.length ?? 0} messages`);
    
    if (!messages || messages.length === 0) {
      logVerbose(`No messages to process for ${chatJid}`);
      return { stored: 0, total: 0 };
    }

    // Log a sample message structure to understand the format
    if (messages.length > 0) {
      const sample = messages[0];
      const sampleKeys = sample ? Object.keys(sample) : [];
      const keyStructure = sample?.key ? Object.keys(sample.key) : [];
      
      logVerbose(
        `Sample message structure: top-level keys=[${sampleKeys.join(", ")}], ` +
        `key object keys=[${keyStructure.join(", ")}]`,
      );
      
      // Check if the result is actually a tuple where messages[0] contains the actual messages array
      // This happens when fetchMessageHistory returns [messages, cursor] or similar
      if (sampleKeys.length === 1 && sampleKeys[0] === "0" && Array.isArray((sample as unknown as Record<string, unknown>)["0"])) {
        logVerbose(`Detected tuple format - unwrapping messages from first element`);
        messages = (sample as unknown as Record<string, unknown>)["0"] as proto.IWebMessageInfo[];
        logVerbose(`After unwrapping: ${messages.length} messages`);
      }
    }

    // Store the fetched messages
    const messageStore = getMessageStore(accountId);
    let stored = 0;

    for (const msg of messages) {
      const id = msg.key?.id;
      const remoteJid = msg.key?.remoteJid;
      
      if (id && remoteJid) {
        messageStore.store(remoteJid, id, msg);
        stored++;
        logVerbose(`Stored message ${id} from ${remoteJid}`);
      } else {
        // Log the structure to understand what we're getting
        const msgKeys = msg ? Object.keys(msg) : [];
        const keyInfo = msg.key ? `key exists with keys: ${Object.keys(msg.key).join(", ")}` : "key is missing";
        logVerbose(
          `Skipping message with missing id or remoteJid: id=${id}, remoteJid=${remoteJid}. ` +
          `Message has keys: [${msgKeys.join(", ")}]. ${keyInfo}`,
        );
      }
    }

    logVerbose(`Stored ${stored} messages from history fetch for ${chatJid}`);
    return { stored, total: stored };
  } catch (err) {
    logVerbose(
      `Failed to fetch history for ${chatJid}: ${String(err)}. ` +
      "This is expected behavior - WhatsApp's protocol limits on-demand history fetching. " +
      "Messages will be available as they arrive or after gateway restart.",
    );
    return { stored: 0, total: 0 };
  }
}
