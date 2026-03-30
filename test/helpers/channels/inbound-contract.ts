import { expect, it, vi } from "vitest";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import { inboundCtxCapture } from "../../../src/channels/plugins/contracts/inbound-testkit.js";
import { expectChannelInboundContextContract } from "../../../src/channels/plugins/contracts/suites.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { ResolvedSlackAccount } from "../../../src/plugin-sdk/slack.js";
import {
	loadBundledPluginTestApiSync,
	resolveRelativeBundledPluginPublicModuleId,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { withTempHome } from "../temp-home.js";

type SlackMessageEvent = {
	channel: string;
	channel_type?: string;
	user?: string;
	text?: string;
	ts: string;
};

type SlackPrepareResult = { ctxPayload: MsgContext } | null | undefined;

const { buildFinalizedDiscordDirectInboundContext } =
	loadBundledPluginTestApiSync<{
		buildFinalizedDiscordDirectInboundContext: () => MsgContext;
	}>("discord");
const { createInboundSlackTestContext, prepareSlackMessage } =
	loadBundledPluginTestApiSync<{
		createInboundSlackTestContext: (params: { cfg: OpenClawConfig }) => {
			resolveUserName?: () => Promise<unknown>;
		};
		prepareSlackMessage: (params: {
			ctx: {
				resolveUserName?: () => Promise<unknown>;
			};
			account: ResolvedSlackAccount;
			message: SlackMessageEvent;
			opts: { source: string };
		}) => Promise<SlackPrepareResult>;
	}>("slack");
const telegramHarnessModuleId = resolveRelativeBundledPluginPublicModuleId({
	fromModuleUrl: import.meta.url,
	pluginId: "telegram",
	artifactBasename: "src/bot-message-context.test-harness.js",
});
const signalApiModuleId = resolveRelativeBundledPluginPublicModuleId({
	fromModuleUrl: import.meta.url,
	pluginId: "signal",
	artifactBasename: "api.js",
});
const whatsAppTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
	fromModuleUrl: import.meta.url,
	pluginId: "whatsapp",
	artifactBasename: "test-api.js",
});

async function buildTelegramMessageContextForTest(params: {
	cfg: OpenClawConfig;
	message: Record<string, unknown>;
}): Promise<{ ctxPayload: MsgContext } | null | undefined> {
	const telegramHarnessModule = (await import(telegramHarnessModuleId)) as {
		buildTelegramMessageContextForTest: (params: {
			cfg: OpenClawConfig;
			message: Record<string, unknown>;
		}) => Promise<{ ctxPayload: MsgContext } | null | undefined>;
	};
	return await telegramHarnessModule.buildTelegramMessageContextForTest(params);
}

const dispatchInboundMessageMock = vi.hoisted(() =>
	vi.fn(
		async (params: {
			ctx: MsgContext;
			replyOptions?: { onReplyStart?: () => void | Promise<void> };
		}) => {
			await Promise.resolve(params.replyOptions?.onReplyStart?.());
			return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
		},
	),
);

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
	return {
		...actual,
		dispatchInboundMessage: vi.fn(async (params: { ctx: MsgContext }) => {
			inboundCtxCapture.ctx = params.ctx;
			return await dispatchInboundMessageMock(params);
		}),
		dispatchInboundMessageWithDispatcher: vi.fn(
			async (params: { ctx: MsgContext }) => {
				inboundCtxCapture.ctx = params.ctx;
				return await dispatchInboundMessageMock(params);
			},
		),
		dispatchInboundMessageWithBufferedDispatcher: vi.fn(
			async (params: { ctx: MsgContext }) => {
				inboundCtxCapture.ctx = params.ctx;
				return await dispatchInboundMessageMock(params);
			},
		),
	};
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("openclaw/plugin-sdk/conversation-runtime")
		>();
	return {
		...actual,
		recordInboundSession: vi.fn(async (params: { ctx: MsgContext }) => {
			inboundCtxCapture.ctx = params.ctx;
		}),
	};
});

vi.doMock(signalApiModuleId, () => ({
	sendMessageSignal: vi.fn(),
	sendTypingSignal: vi.fn(async () => true),
	sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../../../src/pairing/pairing-store.js", () => ({
	readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
	upsertChannelPairingRequest: vi.fn(),
}));

vi.doMock(whatsAppTestApiModuleId, async (importOriginal) => {
	const actual = await importOriginal<object>();
	return {
		...actual,
		trackBackgroundTask: (
			tasks: Set<Promise<unknown>>,
			task: Promise<unknown>,
		) => {
			tasks.add(task);
			void task.finally(() => {
				tasks.delete(task);
			});
		},
		updateLastRouteInBackground: vi.fn(),
		deliverWebReply: vi.fn(async () => {}),
	};
});

const { finalizeInboundContext } = await import(
	"../../../src/auto-reply/reply/inbound-context.js"
);

function createSlackAccount(
	config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
	return {
		accountId: "default",
		enabled: true,
		botTokenSource: "config",
		appTokenSource: "config",
		userTokenSource: "none",
		config,
		replyToMode: config.replyToMode,
		replyToModeByChatType: config.replyToModeByChatType,
		dm: config.dm,
	};
}

function createSlackMessage(
	overrides: Partial<SlackMessageEvent>,
): SlackMessageEvent {
	return {
		channel: "D123",
		channel_type: "im",
		user: "U1",
		text: "hi",
		ts: "1.000",
		...overrides,
	} as SlackMessageEvent;
}

export function installDiscordInboundContractSuite() {
	it("keeps inbound context finalized", () => {
		const ctx = buildFinalizedDiscordDirectInboundContext();

		expectChannelInboundContextContract(ctx);
	});
}

export function installSignalInboundContractSuite() {
	it("keeps inbound context finalized", () => {
		const ctx = finalizeInboundContext({
			Body: "Alice: hi",
			BodyForAgent: "hi",
			RawBody: "hi",
			CommandBody: "hi",
			BodyForCommands: "hi",
			From: "group:g1",
			To: "group:g1",
			SessionKey: "agent:main:signal:group:g1",
			AccountId: "default",
			ChatType: "group",
			ConversationLabel: "Alice",
			GroupSubject: "Test Group",
			SenderName: "Alice",
			SenderId: "+15550001111",
			Provider: "signal",
			Surface: "signal",
			MessageSid: "1700000000000",
			OriginatingChannel: "signal",
			OriginatingTo: "group:g1",
			CommandAuthorized: true,
		});

		expectChannelInboundContextContract(ctx);
	});
}

export function installSlackInboundContractSuite() {
	it("keeps inbound context finalized", async () => {
		await withTempHome(async () => {
			const ctx = createInboundSlackTestContext({
				cfg: {
					channels: { slack: { enabled: true } },
				} as OpenClawConfig,
			});
			ctx.resolveUserName = async () => ({ name: "Alice" }) as never;

			const prepared = await prepareSlackMessage({
				ctx,
				account: createSlackAccount(),
				message: createSlackMessage({}),
				opts: { source: "message" },
			});

			expect(prepared).toBeTruthy();
			expectChannelInboundContextContract(prepared?.ctxPayload);
		});
	});
}

export function installTelegramInboundContractSuite() {
	it("keeps inbound context finalized", async () => {
		const context = await buildTelegramMessageContextForTest({
			cfg: {
				agents: {
					defaults: {
						envelopeTimezone: "utc",
					},
				},
				channels: {
					telegram: {
						groupPolicy: "open",
						groups: { "*": { requireMention: false } },
					},
				},
			} satisfies OpenClawConfig,
			message: {
				chat: { id: 42, type: "group", title: "Ops" },
				text: "hello",
				date: 1736380800,
				message_id: 2,
				from: {
					id: 99,
					first_name: "Ada",
					last_name: "Lovelace",
					username: "ada",
				},
			},
		});

		const payload = context?.ctxPayload;
		expect(payload).toBeTruthy();
		if (!payload) {
			throw new Error("expected telegram inbound payload");
		}
		expectChannelInboundContextContract(payload);
	});
}

export function installWhatsAppInboundContractSuite() {
	it("keeps inbound context finalized", () => {
		const ctx = finalizeInboundContext({
			Body: "Alice: hi",
			BodyForAgent: "hi",
			RawBody: "hi",
			CommandBody: "hi",
			BodyForCommands: "hi",
			From: "123@g.us",
			To: "+15550001111",
			SessionKey: "agent:main:whatsapp:group:123",
			AccountId: "default",
			ChatType: "group",
			ConversationLabel: "123@g.us",
			GroupSubject: "Test Group",
			SenderName: "Alice",
			SenderId: "alice@s.whatsapp.net",
			SenderE164: "+15550002222",
			Provider: "whatsapp",
			Surface: "whatsapp",
			MessageSid: "msg1",
			OriginatingChannel: "whatsapp",
			OriginatingTo: "123@g.us",
			CommandAuthorized: true,
		});

		expectChannelInboundContextContract(ctx);
	});
}
