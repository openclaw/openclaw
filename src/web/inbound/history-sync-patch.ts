/**
 * Patch for Baileys to handle history sync on-demand responses
 * 
 * Baileys has a TODO comment in process-message.js that says:
 * "TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.)"
 * 
 * This module implements the missing history sync response handling.
 */

import type { WASocket, proto } from "@whiskeysockets/baileys";
import { getChildLogger } from "../../logging.js";

const logger = getChildLogger({ module: "history-sync-patch" });

interface HistorySyncRequest {
	requestId: string;
	chatJid: string;
	timestamp: number;
	resolve: (messages: any[]) => void;
	reject: (error: Error) => void;
}

const pendingRequests = new Map<string, HistorySyncRequest>();

/**
 * Patch the Baileys socket to handle history sync on-demand responses
 */
export function patchHistorySyncHandling(sock: WASocket): void {
	logger.info("Patching Baileys socket for history sync on-demand support");

	// Listen for ALL messages to debug
	sock.ev.on("messages.upsert", async (update) => {
		for (const msg of update.messages) {
			// Log all protocol messages for debugging
			const protocolMsg = msg.message?.protocolMessage;
			if (protocolMsg) {
				process.stdout.write(`  🔍 Protocol message type: ${protocolMsg.type}\n`);
			}

			// Check if this is a protocol message
			if (!protocolMsg) continue;

			// Check if it's a peer data operation response
			if (
				protocolMsg.type ===
				(proto.Message.ProtocolMessage.Type
					.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE as any)
			) {
				const response = protocolMsg.peerDataOperationRequestResponseMessage;
				if (!response) continue;

				process.stdout.write(`  ✅ Peer data operation response received!\n`);
				process.stdout.write(`     StanzaId: ${response.stanzaId}\n`);
				process.stdout.write(`     Results: ${response.peerDataOperationResult?.length || 0}\n`);

				logger.debug(
					{ stanzaId: response.stanzaId },
					"Received peer data operation response",
				);

				// Process each result
				for (const result of response.peerDataOperationResult || []) {
					// Log what type of result this is
					process.stdout.write(`     Result keys: ${Object.keys(result).join(", ")}\n`);

					// Check for history sync response
					const historyResponse = result.fullHistorySyncOnDemandRequestResponse;
					if (historyResponse) {
						process.stdout.write(`  📚 History sync response found!\n`);
						process.stdout.write(`     Request ID: ${historyResponse.requestMetadata?.requestId}\n`);
						process.stdout.write(`     Response code: ${historyResponse.responseCode}\n`);

						logger.info(
							{
								requestId: historyResponse.requestMetadata?.requestId,
								responseCode: historyResponse.responseCode,
							},
							"Received history sync on-demand response",
						);

						// Map response codes
						const responseCodeName = getResponseCodeName(historyResponse.responseCode);
						process.stdout.write(`     Response: ${responseCodeName}\n\n`);

						if (historyResponse.responseCode === 0) {
							// REQUEST_SUCCESS
							process.stdout.write(`  ✅ History sync request successful!\n`);
							process.stdout.write(`     Now waiting for HistorySyncNotification message...\n\n`);
						} else {
							process.stdout.write(`  ❌ History sync request failed: ${responseCodeName}\n\n`);
						}
					}
				}
			}

			// Check if this is a history sync notification
			const histNotification = msg.message?.protocolMessage?.historySyncNotification;
			if (histNotification) {
				process.stdout.write(`  📬 History sync notification received!\n`);
				process.stdout.write(`     Sync type: ${histNotification.syncType}\n`);
				process.stdout.write(`     Session ID: ${histNotification.peerDataRequestSessionId}\n\n`);

				logger.info(
					{
						syncType: histNotification.syncType,
						peerDataRequestSessionId: histNotification.peerDataRequestSessionId,
					},
					"Received history sync notification",
				);

				// The notification will be processed by Baileys' existing handler
				// which will emit 'messaging-history.set' event
			}
		}
	});

	// Listen for the messaging-history.set event
	sock.ev.on("messaging-history.set" as any, (data: any) => {
		process.stdout.write(`  📊 messaging-history.set event!\n`);
		process.stdout.write(`     Chats: ${data.chats?.length || 0}\n`);
		process.stdout.write(`     Messages: ${data.messages?.length || 0}\n`);
		process.stdout.write(`     Contacts: ${data.contacts?.length || 0}\n\n`);

		logger.info(
			{
				chats: data.chats?.length,
				messages: data.messages?.length,
				contacts: data.contacts?.length,
				syncType: data.syncType,
				peerDataRequestSessionId: data.peerDataRequestSessionId,
			},
			"History sync data received",
		);
	});
}

function getResponseCodeName(code: number | null | undefined): string {
	const codes: Record<number, string> = {
		0: "REQUEST_SUCCESS",
		1: "REQUEST_TIME_EXPIRED",
		2: "DECLINED_SHARING_HISTORY",
		3: "GENERIC_ERROR",
		4: "ERROR_REQUEST_ON_NON_SMB_PRIMARY",
		5: "ERROR_HOSTED_DEVICE_NOT_CONNECTED",
		6: "ERROR_HOSTED_DEVICE_LOGIN_TIME_NOT_SET",
	};
	return code !== null && code !== undefined ? codes[code] || `UNKNOWN(${code})` : "UNKNOWN";
}

/**
 * Fetch message history with promise-based API
 */
export async function fetchMessageHistoryWithPromise(
	sock: WASocket,
	chatJid: string,
	count: number,
	oldestMsgKey?: { id: string; fromMe: boolean },
	oldestMsgTimestamp?: number,
): Promise<any[]> {
	const timestamp = oldestMsgTimestamp || Date.now();
	const key = oldestMsgKey || {
		id: "FFFFFFFFFFFFFFFFFFFFFFFF",
		fromMe: false,
	};

	process.stdout.write(`  🔍 Preparing to fetch history...\n`);
	process.stdout.write(`     Chat: ${chatJid}\n`);
	process.stdout.write(`     Count: ${count}\n`);
	process.stdout.write(`     Timestamp: ${timestamp} (${new Date(timestamp).toISOString()})\n`);
	process.stdout.write(`     Key ID: ${key.id}\n\n`);

	logger.info({ chatJid, count }, "Fetching message history");

	// Call the Baileys method
	try {
		const messageId = await sock.fetchMessageHistory(count, { remoteJid: chatJid, ...key }, timestamp);

		process.stdout.write(`  ✅ fetchMessageHistory call succeeded!\n`);
		process.stdout.write(`     Returned message ID: ${messageId}\n`);
		process.stdout.write(`     Now waiting for response...\n\n`);

		logger.info({ messageId }, "History fetch request sent");

		// Wait for the history to arrive via messaging-history.set event
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				sock.ev.off("messaging-history.set" as any, handler);
				process.stdout.write(`  ⏰ Timeout reached after 30 seconds\n`);
				process.stdout.write(`     No messaging-history.set event received\n`);
				process.stdout.write(`     No peer data operation response received\n\n`);
				reject(new Error("History sync timeout after 30 seconds"));
			}, 30000);

			const handler = (data: any) => {
				logger.debug({ data }, "Checking history set event");

				// Filter messages for our chat
				const messages = (data.messages || []).filter(
					(msg: any) => msg.key?.remoteJid === chatJid,
				);

				if (messages.length > 0) {
					clearTimeout(timeout);
					sock.ev.off("messaging-history.set" as any, handler);
					logger.info({ count: messages.length }, "History messages received");
					resolve(messages);
				}
			};

			sock.ev.on("messaging-history.set" as any, handler);
		});
	} catch (error: any) {
		process.stdout.write(`  ❌ fetchMessageHistory call failed!\n`);
		process.stdout.write(`     Error: ${error.message}\n\n`);
		throw error;
	}
}
