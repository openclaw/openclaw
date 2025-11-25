import { ensureBinary } from "../infra/binaries.js";
import { ensurePortAvailable, handlePortError } from "../infra/ports.js";
import { ensureFunnel, getTailnetHostname } from "../infra/tailscale.js";
import { waitForever } from "./wait.js";
import { readEnv } from "../env.js";
import { monitorTwilio as monitorTwilioImpl } from "../twilio/monitor.js";
import { sendMessage, waitForFinalStatus } from "../twilio/send.js";
import { sendMessageWeb, monitorWebProvider, logWebSelfId } from "../provider-web.js";
import { assertProvider, sleep } from "../utils.js";
import { createClient } from "../twilio/client.js";
import { listRecentMessages } from "../twilio/messages.js";
import { updateWebhook } from "../twilio/update-webhook.js";
import { findWhatsappSenderSid } from "../twilio/senders.js";
import { startWebhook } from "../twilio/webhook.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { info } from "../globals.js";
import { autoReplyIfConfigured } from "../auto-reply/reply.js";

export type CliDeps = {
	sendMessage: typeof sendMessage;
	sendMessageWeb: typeof sendMessageWeb;
	waitForFinalStatus: typeof waitForFinalStatus;
	assertProvider: typeof assertProvider;
	createClient?: typeof createClient;
	monitorTwilio: typeof monitorTwilio;
	listRecentMessages: typeof listRecentMessages;
	ensurePortAvailable: typeof ensurePortAvailable;
	startWebhook: typeof import("../twilio/webhook.js").startWebhook;
	waitForever: typeof waitForever;
	ensureBinary: typeof ensureBinary;
	ensureFunnel: typeof ensureFunnel;
	getTailnetHostname: typeof getTailnetHostname;
	readEnv: typeof readEnv;
	findWhatsappSenderSid: typeof findWhatsappSenderSid;
	updateWebhook: typeof updateWebhook;
	handlePortError: typeof handlePortError;
	monitorWebProvider: typeof monitorWebProvider;
};

export async function monitorTwilio(
	intervalSeconds: number,
	lookbackMinutes: number,
	clientOverride?: ReturnType<typeof createClient>,
	maxIterations = Infinity,
) {
	// Adapter that wires default deps/runtime for the Twilio monitor loop.
	return monitorTwilioImpl(intervalSeconds, lookbackMinutes, {
		client: clientOverride,
		maxIterations,
		deps: {
			autoReplyIfConfigured,
			listRecentMessages,
			readEnv,
			createClient,
			sleep,
		},
		runtime: defaultRuntime,
	});
}

export function createDefaultDeps(): CliDeps {
	// Default dependency bundle used by CLI commands and tests.
	return {
		sendMessage,
		sendMessageWeb,
		waitForFinalStatus,
		assertProvider,
		createClient,
		monitorTwilio,
		listRecentMessages,
		ensurePortAvailable,
		startWebhook,
		waitForever,
		ensureBinary,
		ensureFunnel,
		getTailnetHostname,
		readEnv,
		findWhatsappSenderSid,
		updateWebhook,
		handlePortError,
		monitorWebProvider,
	};
}

export function logTwilioFrom(runtime: RuntimeEnv = defaultRuntime) {
	// Log the configured Twilio sender for clarity in CLI output.
	const env = readEnv(runtime);
	runtime.log(
		info(`Provider: twilio (polling inbound) | from ${env.whatsappFrom}`),
	);
}

export { logWebSelfId };
