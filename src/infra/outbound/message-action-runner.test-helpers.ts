// Isolate runner routing and send coordination from channel/Gateway runtimes.
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

// Mock factories run before the exported alias initializes; use the hoisted binding.
const runnerMocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  hasCorePresentationDelivery: vi.fn(),
  materializeMessagePresentationFallback: vi.fn(),
  callGateway: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway-action"),
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
  isDeliveredCurrentSourceReplyAsync: vi.fn(async () => false),
  loadWebMedia: vi.fn<typeof import("../../media/web-media.js").loadWebMedia>(),
}));

export const messageActionRunnerMocks = runnerMocks;

// mock-isolation: Resolve only the synthetic channel instead of loading bundled plugins.
vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined,
  resolveOutboundChannelPlugin: runnerMocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

// mock-isolation: Observe runner dispatch without invoking delivery and recovery services.
vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: runnerMocks.executeSendAction,
  executePollAction: runnerMocks.executePollAction,
  hasCorePresentationDelivery: runnerMocks.hasCorePresentationDelivery,
  materializeMessagePresentationFallback: runnerMocks.materializeMessagePresentationFallback,
}));

// mock-isolation: Control Gateway outcomes without opening a live connection.
vi.mock("./message.gateway.runtime.js", () => ({
  callGateway: runnerMocks.callGateway,
  callGatewayLeastPrivilege: runnerMocks.callGatewayLeastPrivilege,
  isGatewayTransportError: runnerMocks.isGatewayTransportError,
  randomIdempotencyKey: runnerMocks.randomIdempotencyKey,
}));

// mock-isolation: Observe source-reply settlement without changing real session transcripts.
vi.mock("./source-reply-mirror.js", () => ({
  isDeliveredCurrentSourceReplyAsync: runnerMocks.isDeliveredCurrentSourceReplyAsync,
}));

// mock-isolation: Keep speech synthesis at the payload boundary without loading providers.
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: runnerMocks.maybeApplyTtsToPayload,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "actionhub"
      ? {
          actions: {
            messageActionTargetAliases: {
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
            },
          },
        }
      : undefined,
}));

vi.mock("../../media/web-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../media/web-media.js")>()),
  loadWebMedia: runnerMocks.loadWebMedia,
}));

type RunMessageAction = typeof import("./message-action-runner.js").runMessageAction;

export const runMessageAction: RunMessageAction = async (...args) =>
  (await import("./message-action-runner.js")).runMessageAction(...args);

export function setMessageActionTestPlugin(plugin: unknown, pluginId: string, origin?: "bundled") {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId, source: "test", ...(origin ? { origin } : {}), plugin }]),
  );
}

export function createWorkspaceMediaTestPlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "workspace",
      label: "Workspace",
      config: {
        resolveAccount: (cfg) => cfg.channels?.workspace ?? {},
        isConfigured: async (account) => {
          const { botToken, appToken } = account as { botToken?: unknown; appToken?: unknown };
          return [botToken, appToken].every(
            (token) => typeof token === "string" && token.trim() !== "",
          );
        },
      },
    }),
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) => {
        const trimmed = to?.trim() ?? "";
        return trimmed
          ? { ok: true, to: trimmed }
          : { ok: false, error: new Error("missing target for workspace") };
      },
      sendText: async () => ({ channel: "workspace", messageId: "msg-test" }),
      sendMedia: async () => ({ channel: "workspace", messageId: "msg-test" }),
    },
  };
}

export function createAlwaysConfiguredPluginConfig(
  account: Record<string, unknown> = { enabled: true },
) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
  };
}

export function createActionPluginBase(id: string, label: string, blurb: string): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id,
    label,
    config: createAlwaysConfiguredPluginConfig(),
  });
  return { ...base, meta: { ...base.meta, blurb } };
}

function createActionHubPluginFixture() {
  const actions: ChannelMessageActionName[] = [
    "pin",
    "unpin",
    "list-pins",
    "member-info",
    "channel-info",
    "edit",
    "thread-create",
    "thread-reply",
  ];
  const targetAliases = () => ({
    aliases: ["messageId", "chatId", "chat_id", "channel_id"],
    deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
  });
  const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
    jsonResult({ ok: true, params }),
  );
  const plugin: ChannelPlugin = {
    ...createActionPluginBase("actionhub", "Action Hub", "Action Hub action dispatch test plugin."),
    capabilities: { chatTypes: ["direct", "channel"] },
    messaging: {
      targetPrefixes: ["actionhub", "actionhub-alias"],
      normalizeTarget: (raw) => raw.replace(/^actionhub-alias:/i, "actionhub:"),
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions }),
      messageActionTargetAliases: {
        "list-pins": { aliases: ["chatId"] },
        edit: targetAliases(),
        pin: targetAliases(),
        unpin: targetAliases(),
      },
      supportsAction: ({ action }) => actions.includes(action),
      handleAction,
    },
  };
  return { handleAction, plugin };
}

export function createGatewayActionPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  actions: ChannelMessageActionName[];
  gatewayActions?: ChannelMessageActionName[];
  capabilities?: ChannelPlugin["capabilities"];
  messaging?: ChannelPlugin["messaging"];
  threading?: ChannelPlugin["threading"];
  handleAction: ChannelActionHandler;
}): ChannelPlugin & { actions: NonNullable<ChannelPlugin["actions"]> } {
  const actions = new Set(params.actions);
  const gatewayActions = new Set(params.gatewayActions ?? params.actions);
  return {
    ...createActionPluginBase(params.pluginId, params.label, params.blurb),
    capabilities: params.capabilities ?? { chatTypes: ["direct"] },
    messaging: params.messaging,
    threading: params.threading,
    actions: {
      describeMessageTool: () => ({ actions: params.actions }),
      supportsAction: ({ action }) => actions.has(action),
      resolveExecutionMode: ({ action }) => (gatewayActions.has(action) ? "gateway" : "local"),
      handleAction: params.handleAction,
    },
  };
}

export function createPollForwardingPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  return {
    ...createActionPluginBase(params.pluginId, params.label, params.blurb),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      supportsAction: ({ action }) => action === "poll",
      handleAction: params.handleAction,
    },
  };
}

type SendParams = Parameters<typeof import("./outbound-send-service.js").executeSendAction>[0];

async function executePluginAction({
  action,
  ctx,
}: {
  action: "send" | "poll";
  ctx: SendParams["ctx"];
}) {
  const handled = await dispatchChannelMessageAction({
    channel: ctx.channel,
    action,
    cfg: ctx.cfg,
    params: ctx.params,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaAccess?.localRoots ?? [],
    mediaReadFile:
      typeof ctx.mediaAccess?.readFile === "function" ? ctx.mediaAccess.readFile : undefined,
    accountId: ctx.accountId ?? undefined,
    gateway: ctx.gateway,
    toolContext: ctx.input.toolContext,
    inboundEventKind: ctx.input.inboundEventKind,
    dryRun: ctx.dryRun,
    agentId: ctx.agentId,
  });
  if (!handled) {
    throw new Error(`expected plugin to handle ${action}`);
  }
  return {
    handledBy: "plugin" as const,
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

function resetMock<F extends (...args: never[]) => unknown>(
  mock: MockInstance<F>,
  implementation: NonNullable<ReturnType<MockInstance<F>["getMockImplementation"]>>,
) {
  mock.mockReset();
  mock.mockImplementation(implementation);
}
const resolveTestPlugin = ({ channel }: { channel: string }) =>
  getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin;

export function resetMessageActionRunnerMocks() {
  const mocks = messageActionRunnerMocks;
  resetMock(mocks.resolveOutboundChannelPlugin, resolveTestPlugin);
  resetMock(
    mocks.executeSendAction,
    async ({ ctx }: { ctx: SendParams["ctx"] }) =>
      await executePluginAction({ action: "send", ctx }),
  );
  resetMock(
    mocks.executePollAction,
    async ({ ctx }: { ctx: SendParams["ctx"] }) =>
      await executePluginAction({ action: "poll", ctx }),
  );
  resetMock(
    mocks.hasCorePresentationDelivery,
    (outbound?: { sendPayload?: unknown; sendText?: unknown; sendFormattedText?: unknown }) =>
      Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText),
  );
  resetMock(
    mocks.materializeMessagePresentationFallback,
    (params: { payload: { presentation?: unknown; text?: string }; text?: string }) => {
      const presentation = normalizeMessagePresentation(params.payload.presentation);
      const text = (params.text ?? params.payload.text ?? "").trim();
      const fallback = presentation ? renderMessagePresentationFallbackText({ presentation }) : "";
      return !fallback || text.includes(fallback)
        ? text
        : [text, fallback].filter(Boolean).join("\n\n");
    },
  );
  mocks.callGateway.mockReset();
  mocks.callGatewayLeastPrivilege.mockReset();
  resetMock(
    mocks.isGatewayTransportError,
    (value: unknown) => value instanceof Error && (value as { kind?: unknown }).kind === "timeout",
  );
  mocks.randomIdempotencyKey.mockClear();
  resetMock(mocks.maybeApplyTtsToPayload, async (params: { payload: unknown }) => params.payload);
}

let actualLoadWebMedia: typeof import("../../media/web-media.js").loadWebMedia | undefined;

export async function resetMessageActionMediaMocks() {
  actualLoadWebMedia ??= (
    await vi.importActual<typeof import("../../media/web-media.js")>("../../media/web-media.js")
  ).loadWebMedia;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const mocks = messageActionRunnerMocks;
  resetMock(mocks.resolveOutboundChannelPlugin, resolveTestPlugin);
  resetMock(
    mocks.executeSendAction,
    async ({ ctx, to, message, mediaUrl, mediaUrls }: SendParams) => ({
      handledBy: "core" as const,
      payload: {
        channel: ctx.channel,
        to,
        message,
        mediaUrl,
        mediaUrls,
        dryRun: ctx.dryRun,
      },
      sendResult: {
        channel: ctx.channel,
        messageId: "msg-test",
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(mediaUrls ? { mediaUrls } : {}),
      },
    }),
  );
  resetMock(mocks.executePollAction, async () => {
    throw new Error("executePollAction should not run in media tests");
  });
  resetMock(mocks.loadWebMedia, actualLoadWebMedia);
}

type RecordedCalls = { mock: { calls: unknown[][] } };

const requireRecord = createRequireRecord("record", "expected-non-array-record");
const requireLabeledRecord = createRequireRecord("record", "expected-label");

export const readFirstPluginCall = (mock: RecordedCalls) => readPluginCall(mock, 0);

export function readPluginCall(mock: RecordedCalls, callIndex: number): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

export const readLastPluginCall = (mock: RecordedCalls) =>
  readPluginCall(mock, mock.mock.calls.length - 1);

export const readMockCallArg = (mock: RecordedCalls, label: string, callIndex = 0) =>
  requireLabeledRecord(mock.mock.calls[callIndex]?.[0], label);

export const readRecordField = (record: Record<string, unknown>, key: string, label: string) =>
  requireLabeledRecord(record[key], label);

export function expectRecordFields(
  record: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(value);
  }
}

export const createEnabledMessageActionConfig = (channel: string): OpenClawConfig => ({
  channels: { [channel]: { enabled: true } },
});

export function useActionHubPluginFixture() {
  const fixture = createActionHubPluginFixture();
  beforeEach(() => {
    setMessageActionTestPlugin(fixture.plugin, "actionhub");
    fixture.handleAction.mockClear();
  });
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  return fixture;
}
