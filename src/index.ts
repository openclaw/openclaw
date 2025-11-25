#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import type { TwilioRequester } from "./twilio/types.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";
import { sendTypingIndicator } from "./twilio/typing.js";
import { autoReplyIfConfigured, getReplyFromConfig } from "./auto-reply/reply.js";
import { readEnv, ensureTwilioEnv, type EnvConfig } from "./env.js";
import { createClient } from "./twilio/client.js";
import { logTwilioSendError, formatTwilioError } from "./twilio/utils.js";
import { sendMessage, waitForFinalStatus } from "./twilio/send.js";
import { startWebhook as startWebhookImpl } from "./twilio/webhook.js";
import {
	updateWebhook as updateWebhookImpl,
	findIncomingNumberSid as findIncomingNumberSidImpl,
	findMessagingServiceSid as findMessagingServiceSidImpl,
	setMessagingServiceWebhook as setMessagingServiceWebhookImpl,
} from "./twilio/update-webhook.js";
import { listRecentMessages, formatMessageLine, uniqueBySid, sortByDateDesc } from "./twilio/messages.js";
import { CLAUDE_BIN } from "./auto-reply/claude.js";
import { applyTemplate, type MsgContext, type TemplateContext } from "./auto-reply/templating.js";
import {
	CONFIG_PATH,
	type WarelayConfig,
	type SessionConfig,
	type SessionScope,
	type ReplyMode,
	type ClaudeOutputFormat,
	loadConfig,
} from "./config/config.js";
import { sendCommand } from "./commands/send.js";
import { statusCommand } from "./commands/status.js";
import { upCommand } from "./commands/up.js";
import { webhookCommand } from "./commands/webhook.js";
import type { Provider } from "./utils.js";
import {
	assertProvider,
	CONFIG_DIR,
	jidToE164,
	normalizeE164,
	normalizePath,
	sleep,
	toWhatsappJid,
	withWhatsAppPrefix,
} from "./utils.js";
import {
	DEFAULT_IDLE_MINUTES,
	DEFAULT_RESET_TRIGGER,
	deriveSessionKey,
	loadSessionStore,
	resolveStorePath,
	saveSessionStore,
	SESSION_STORE_DEFAULT,
} from "./config/sessions.js";
import { ensurePortAvailable, describePortOwner, PortInUseError, handlePortError } from "./infra/ports.js";
import { ensureBinary } from "./infra/binaries.js";
import { ensureFunnel, ensureGoInstalled, ensureTailscaledInstalled, getTailnetHostname } from "./infra/tailscale.js";
import { promptYesNo } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { findWhatsappSenderSid } from "./twilio/senders.js";
import { createDefaultDeps, logTwilioFrom, logWebSelfId, monitorTwilio } from "./cli/deps.js";
import { monitorWebProvider } from "./provider-web.js";

dotenv.config({ quiet: true });

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

// Keep aliases for backwards compatibility with prior index exports.
const startWebhook = startWebhookImpl;
const setMessagingServiceWebhook = setMessagingServiceWebhookImpl;
const updateWebhook = updateWebhookImpl;

export {
	assertProvider,
	autoReplyIfConfigured,
	applyTemplate,
	createClient,
	deriveSessionKey,
	describePortOwner,
	ensureBinary,
	ensureFunnel,
	ensureGoInstalled,
	ensurePortAvailable,
	ensureTailscaledInstalled,
	findIncomingNumberSidImpl as findIncomingNumberSid,
	findMessagingServiceSidImpl as findMessagingServiceSid,
	findWhatsappSenderSid,
	formatMessageLine,
	formatTwilioError,
	getReplyFromConfig,
	getTailnetHostname,
	handlePortError,
	logTwilioSendError,
	listRecentMessages,
	loadConfig,
	loadSessionStore,
	monitorTwilio,
	monitorWebProvider,
	normalizeE164,
	PortInUseError,
	promptYesNo,
	createDefaultDeps,
	readEnv,
	resolveStorePath,
	runCommandWithTimeout,
	runExec,
	saveSessionStore,
	sendMessage,
	sendTypingIndicator,
	setMessagingServiceWebhook,
	sortByDateDesc,
	startWebhook,
	updateWebhook,
	uniqueBySid,
	waitForFinalStatus,
	waitForever,
	toWhatsappJid,
	program,
};

const isMain =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
	program.parseAsync(process.argv);
}
