// Send method tests cover outbound message routing, transcript mirroring, poll
// dispatch, plugin channel selection, and durable delivery dependencies.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import { OutboundEffectAuthorizationError } from "../../infra/outbound/effect-authorization.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationPolicyHandler,
  TurnAuthoritySnapshot,
} from "../../plugins/authorization-policy.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ResolveOutboundTarget = typeof import("../../infra/outbound/targets.js").resolveOutboundTarget;

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn<() => Promise<SessionTranscriptAppendResult>>(
    async () => ({ ok: true, sessionFile: "x", messageId: "message-x" }),
  ),
  beginRestartRecoveryTerminalDelivery: vi.fn<
    () => Promise<"started" | "blocked" | "stale" | "not-applicable">
  >(async () => "started"),
  cancelRestartRecoveryTerminalDelivery: vi.fn(async () => "cleared" as const),
  completeRestartRecoveryTerminalDelivery: vi.fn(async () => "recorded" as const),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn<ResolveOutboundTarget>(() => ({ ok: true, to: "resolved" })),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  dispatchChannelMessageAction: vi.fn(),
  sendPoll: vi.fn<
    () => Promise<{
      messageId: string;
      toJid?: string;
      channelId?: string;
      conversationId?: string;
      pollId?: string;
    }>
  >(async () => ({ messageId: "poll-1" })),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  getRuntimeConfigSnapshot: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  loadSessionEntry: vi.fn(
    (sessionKey: string): { canonicalKey: string; entry: { sessionId: string } | undefined } => ({
      canonicalKey: sessionKey,
      entry: undefined,
    }),
  ),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => ({}),
  };
});

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return {
    ...actual,
    getLoadedChannelPlugin: mocks.getChannelPlugin,
    getChannelPlugin: mocks.getChannelPlugin,
    normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
  };
});

vi.mock("../../channels/plugins/message-action-dispatch.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../channels/plugins/message-action-dispatch.js")
  >("../../channels/plugins/message-action-dispatch.js");
  return {
    ...actual,
    dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
  };
});

const TEST_AGENT_WORKSPACE = "/tmp/openclaw-test-workspace";
let sendHandlers: typeof import("./send.js").sendHandlers;

function resolveAgentIdFromSessionKeyForTests(params: { sessionKey?: string }): string {
  if (typeof params.sessionKey === "string") {
    const match = params.sessionKey.match(/^agent:([^:]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "main";
}

function messageActionContextFromSessionKeyForTests(sessionKey: string): {
  expiresAtMs: number;
  toolContext?: {
    currentChannelProvider?: string;
    currentChannelId?: string;
    currentChatType?: "direct" | "group" | "channel";
  };
} {
  const parts = sessionKey.split(":");
  const provider = parts[2];
  const peerKind = parts[3];
  const peerId = parts.slice(4).join(":");
  const currentChatType =
    peerKind === "direct" || peerKind === "dm"
      ? "direct"
      : peerKind === "group" || peerKind === "channel"
        ? peerKind
        : undefined;
  return {
    expiresAtMs: Date.now() + 60_000,
    toolContext:
      provider && peerId
        ? {
            currentChannelProvider: provider,
            currentChannelId: peerId,
            currentChatType,
          }
        : undefined,
  };
}

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: ({
      sessionKey,
    }: {
      sessionKey?: string;
      config?: unknown;
      agentId?: string;
    }) => resolveAgentIdFromSessionKeyForTests({ sessionKey }),
    resolveDefaultAgentId: () => "main",
    resolveAgentWorkspaceDir: () => TEST_AGENT_WORKSPACE,
  };
});

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config, env }: { config: unknown; env?: unknown }) =>
    mocks.applyPluginAutoEnable({ config, env }),
}));

vi.mock("../../config/runtime-snapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/runtime-snapshot.js")>(
    "../../config/runtime-snapshot.js",
  );
  return {
    ...actual,
    getRuntimeConfigSnapshot: mocks.getRuntimeConfigSnapshot,
    getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
  };
});

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  resolveRuntimePluginRegistry: vi.fn(),
}));

vi.mock("../../infra/outbound/channel-bootstrap.runtime.js", () => ({
  bootstrapOutboundChannelPlugin: vi.fn(),
  resetOutboundChannelBootstrapStateForTests: vi.fn(),
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
}));

vi.mock("../../infra/outbound/channel-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/outbound/channel-selection.js")>(
    "../../infra/outbound/channel-selection.js",
  );
  return {
    ...actual,
    resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
  };
});

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

vi.mock("../../config/sessions/restart-recovery-receipt.js", () => ({
  beginRestartRecoveryTerminalDelivery: mocks.beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery: mocks.cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery: mocks.completeRestartRecoveryTerminalDelivery,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

async function loadSendHandlersForTest() {
  ({ sendHandlers } = await import("./send.js"));
}

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  }) as unknown as GatewayRequestContext;

type TestGatewayClient = {
  connId?: string;
  pairedClientId?: string;
  connect?: {
    scopes?: string[];
    client?: { id: string; mode: string };
  };
  internal?: {
    agentRuntimeIdentity?: {
      kind: "agentRuntime";
      agentId: string;
      sessionKey: string;
      gatewayMethods?: readonly string[];
      messageActionContext?: {
        expiresAtMs: number;
        sessionId?: string;
        sourceReplyFinal?: boolean;
        sourceReplyToolCallId?: string;
        requesterAccountId?: string;
        requesterSenderId?: string;
        requesterSenderIsOwner?: boolean;
        requesterIsAuthorizedSender?: boolean;
        requesterRoleIds?: string[];
        parentConversationId?: string;
        turnAuthority?: TurnAuthoritySnapshot;
        toolContext?: Record<string, unknown>;
      };
    };
  };
};

async function runSend(params: Record<string, unknown>) {
  return await runSendWithClient(params);
}

async function runSendWithClient(
  params: Record<string, unknown>,
  client?: TestGatewayClient | null,
) {
  const respond = vi.fn();
  await expectDefined(sendHandlers.send, "sendHandlers.send test invariant").call(sendHandlers, {
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "send" },
    client: (client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

async function runPoll(params: Record<string, unknown>) {
  return await runPollWithClient(params);
}

async function runPollWithClient(
  params: Record<string, unknown>,
  client?: TestGatewayClient | null,
) {
  const respond = vi.fn();
  await expectDefined(sendHandlers.poll, "sendHandlers.poll test invariant").call(sendHandlers, {
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "poll" },
    client: (client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function runMessageActionRequest(
  params: Record<string, unknown>,
  client?: TestGatewayClient | null,
) {
  const respond = vi.fn();
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
  const agentId =
    typeof params.agentId === "string"
      ? params.agentId
      : sessionKey
        ? resolveAgentIdFromSessionKeyForTests({ sessionKey })
        : undefined;
  const effectiveClient =
    client === undefined && sessionKey && agentId
      ? {
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime" as const,
              agentId,
              sessionKey,
              messageActionContext: {
                expiresAtMs: Date.now() + 60_000,
                sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
                requesterAccountId:
                  typeof params.requesterAccountId === "string"
                    ? params.requesterAccountId
                    : undefined,
                requesterSenderId:
                  typeof params.requesterSenderId === "string"
                    ? params.requesterSenderId
                    : undefined,
                toolContext: {
                  ...messageActionContextFromSessionKeyForTests(sessionKey).toolContext,
                  ...(params.toolContext && typeof params.toolContext === "object"
                    ? params.toolContext
                    : {}),
                },
              },
            },
          },
        }
      : client;
  await expectDefined(
    sendHandlers["message.action"],
    'sendHandlers["message.action"] test invariant',
  )({
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "message.action" },
    client: (effectiveClient ?? null) as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

function directCliClient() {
  return {
    connect: {
      client: {
        id: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    },
  };
}

function deviceLessOperatorClient(connId: string): TestGatewayClient {
  return {
    connId,
    pairedClientId: "paired-cli",
    connect: {
      scopes: ["operator.write"],
      client: {
        id: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    },
  };
}

function agentRuntimeClient(sessionKey: string, agentId = "main"): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        version: "test",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId,
        sessionKey,
        gatewayMethods: ["message.action"],
        messageActionContext: messageActionContextFromSessionKeyForTests(sessionKey),
      },
    },
  };
}

function senderAgentRuntimeClient(params: {
  agentId?: string;
  sessionKey: string;
  expiresAtMs?: number;
  sessionId?: string;
  accountId?: string;
  senderId?: string | null;
  roleIds?: string[];
  sourceConversationId?: string;
  parentConversationId?: string;
  sourceThreadId?: string;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  omitToolContext?: boolean;
}): TestGatewayClient {
  return {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: params.agentId ?? "main",
        sessionKey: params.sessionKey,
        messageActionContext: {
          expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
          sessionId: params.sessionId,
          requesterAccountId: params.accountId ?? "ops",
          requesterSenderId:
            params.senderId === null ? undefined : (params.senderId ?? "maintainer-1"),
          requesterSenderIsOwner: false,
          requesterIsAuthorizedSender: true,
          requesterRoleIds: params.roleIds ?? ["maintainers"],
          parentConversationId: params.parentConversationId,
          sourceReplyFinal: params.sourceReplyFinal,
          sourceReplyToolCallId: params.sourceReplyToolCallId,
          toolContext: params.omitToolContext
            ? undefined
            : {
                currentChannelProvider: "slack",
                currentChannelId: params.sourceConversationId ?? "source-C1",
                currentThreadTs: params.sourceThreadId,
                currentChatType: "channel",
              },
        },
      },
    },
  };
}

function delegatedSenderAgentRuntimeClient(params: {
  agentId: string;
  sessionKey: string;
  sourceConversationId: string;
}): TestGatewayClient {
  return {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        messageActionContext: {
          expiresAtMs: Date.now() + 60_000,
          turnAuthority: createTurnAuthoritySnapshot({
            principal: {
              kind: "sender",
              provider: "discord",
              accountId: "molty",
              senderId: "restricted-maintainer",
              senderIsOwner: false,
              isAuthorizedSender: true,
              roleIds: ["maintainers"],
            },
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            conversationId: params.sourceConversationId,
            threadId: "source-thread",
            trigger: "sessions_send",
            controllerKey: "sender:discord:molty:restricted-maintainer",
          }),
        },
      },
    },
  };
}

async function withTempOpenClawStateDir<T>(test: (stateDir: string) => Promise<T>): Promise<T> {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-send-state-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  try {
    return await test(stateDir);
  } finally {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function deliveryCall(index = 0): Record<string, any> | undefined {
  const calls = mocks.deliverOutboundPayloads.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function appendTranscriptCall(index = 0): Record<string, any> | undefined {
  const calls = mocks.appendAssistantMessageToSessionTranscript.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>) {
  const calls = respond.mock.calls as unknown as Array<
    [
      boolean,
      Record<string, any> | undefined,
      Record<string, any> | undefined,
      Record<string, any> | undefined,
    ]
  >;
  const call = calls[0];
  if (!call) {
    throw new Error("Expected respond call");
  }
  return call;
}

function lastDispatchChannelMessageActionCall(): Record<string, any> | undefined {
  const calls = mocks.dispatchChannelMessageAction.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls.at(-1)?.[0];
}

function pollCall(index = 0): Record<string, any> {
  const calls = mocks.sendPoll.mock.calls as unknown as Array<[Record<string, any>]>;
  const call = calls[index]?.[0];
  if (!call) {
    throw new Error(`Expected poll call at index ${index}`);
  }
  return call;
}

function outboundRouteCall(index = 0): Record<string, any> | undefined {
  const calls = mocks.resolveOutboundSessionRoute.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function ensureSessionEntryCall(index = 0): Record<string, any> | undefined {
  const calls = mocks.ensureOutboundSessionEntry.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function expectDeliverySessionMirror(params: { agentId: string; sessionKey: string }) {
  const call = deliveryCall();
  expect(call?.session?.agentId).toBe(params.agentId);
  expect(call?.session?.key).toBe(params.sessionKey);
  expect(call?.mirror?.sessionKey).toBe(params.sessionKey);
  expect(call?.mirror?.agentId).toBe(params.agentId);
}

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

function installGatewayMessageActionPolicy(handler: AuthorizationPolicyHandler<"message.action">) {
  const registry = createTestRegistry([]);
  registry.authorizationPolicies.push({
    pluginId: "gateway-message-action-policy-test",
    pluginName: "Gateway message action policy test",
    origin: "workspace",
    source: "test",
    policy: {
      id: "gateway-message-action-policy-test",
      description: "Tests Gateway message action authorization",
      handlers: { "message.action": handler },
    },
  });
  setActivePluginRegistry(registry, "send-authorization-policy-test");
}

describe("gateway send mirroring", () => {
  let registrySeq = 0;

  beforeAll(async () => {
    await loadSendHandlersForTest();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `send-test-${registrySeq}`);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.getRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(null);
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: undefined,
    }));
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "resolved" });
    mocks.resolveOutboundSessionRoute.mockImplementation(
      async ({ agentId, channel }: { agentId?: string; channel?: string }) => ({
        sessionKey:
          channel === "slack"
            ? `agent:${agentId ?? "main"}:slack:channel:resolved`
            : `agent:${agentId ?? "main"}:${channel ?? "main"}:resolved`,
      }),
    );
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      configured: ["slack"],
    });
    mocks.dispatchChannelMessageAction.mockResolvedValue({
      details: { action: "handled" },
    });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    mocks.getChannelPlugin.mockReturnValue({
      actions: { handleAction: true },
      outbound: { sendPoll: mocks.sendPoll },
    });
  });

  it("uses the resolved runtime config for message.action when the source snapshot matches", async () => {
    const sourceConfig = {
      channels: {
        discord: {
          accounts: {
            drclaw: {
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN_DRCLAW",
              },
            },
          },
        },
      },
    };
    const runtimeConfig = {
      channels: {
        discord: {
          accounts: {
            drclaw: {
              token: "resolved-token",
            },
          },
        },
      },
    };
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.getRuntimeConfigSnapshot.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(sourceConfig);

    const context = {
      ...makeContext(),
      getRuntimeConfig: () => sourceConfig,
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    await expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "discord",
        action: "channel-info",
        params: { channelId: "123", accountId: "drclaw" },
        idempotencyKey: "idem-action-runtime-config",
      } as never,
      respond,
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(mocks.getRuntimeConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getRuntimeConfigSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(lastDispatchChannelMessageActionCall()?.cfg).toBe(runtimeConfig);
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
  });

  it("matches message.action runtime config against the canonical pre-auto-enable source config", async () => {
    const sourceConfig = {
      channels: {
        discord: {
          accounts: {
            drclaw: {
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN_DRCLAW",
              },
            },
          },
        },
      },
    };
    const autoEnabledSourceConfig = {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            drclaw: {
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN_DRCLAW",
              },
            },
          },
        },
      },
      plugins: { allow: ["discord"] },
    };
    const autoEnabledRuntimeConfig = {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            drclaw: {
              token: "resolved-token",
            },
          },
        },
      },
      plugins: { allow: ["discord"] },
    };
    mocks.applyPluginAutoEnable
      .mockReturnValueOnce({
        config: autoEnabledSourceConfig,
        changes: [{ path: "channels.discord.enabled", value: true }],
        autoEnabledReasons: {},
      })
      .mockReturnValueOnce({
        config: autoEnabledRuntimeConfig,
        changes: [{ path: "channels.discord.enabled", value: true }],
        autoEnabledReasons: {},
      });
    mocks.getRuntimeConfigSnapshot.mockReturnValue(autoEnabledRuntimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(sourceConfig);

    const context = {
      ...makeContext(),
      getRuntimeConfig: () => sourceConfig,
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    await expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "discord",
        action: "channel-info",
        params: { channelId: "123", accountId: "drclaw" },
        idempotencyKey: "idem-action-runtime-config-auto-enabled",
      } as never,
      respond,
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(lastDispatchChannelMessageActionCall()?.cfg).toBe(autoEnabledRuntimeConfig);
    expect(mocks.applyPluginAutoEnable).toHaveBeenNthCalledWith(1, {
      config: sourceConfig,
      env: undefined,
    });
    expect(mocks.applyPluginAutoEnable).toHaveBeenNthCalledWith(2, {
      config: autoEnabledRuntimeConfig,
      env: undefined,
    });
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
  });

  it("keeps the post-auto-enable request config for message.action when the runtime source snapshot does not match", async () => {
    const sourceConfig = {
      channels: {
        discord: {
          accounts: {
            drclaw: {
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN_DRCLAW",
              },
            },
          },
        },
      },
    };
    const autoEnabledRequestConfig = {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            drclaw: {
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN_DRCLAW",
              },
            },
          },
        },
      },
      plugins: { allow: ["discord"] },
    };
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledRequestConfig,
      changes: [{ path: "channels.discord.enabled", value: true }],
      autoEnabledReasons: {},
    });
    mocks.getRuntimeConfigSnapshot.mockReturnValue({
      channels: {
        discord: {
          accounts: {
            drclaw: { token: "stale-runtime-token" },
          },
        },
      },
    });
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue({
      channels: {
        discord: {
          accounts: {
            other: { token: "different-source" },
          },
        },
      },
    });

    const context = {
      ...makeContext(),
      getRuntimeConfig: () => sourceConfig,
    } as unknown as GatewayRequestContext;
    await expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "discord",
        action: "channel-info",
        params: { channelId: "123", accountId: "drclaw" },
        idempotencyKey: "idem-action-stale-runtime-config",
      } as never,
      respond: vi.fn(),
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(lastDispatchChannelMessageActionCall()?.cfg).toBe(autoEnabledRequestConfig);
  });

  it("does not read the runtime config snapshot for send requests", async () => {
    mockDeliverySuccess("m-no-runtime-config-read");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-send-no-runtime-config-read",
    });

    expect(mocks.getRuntimeConfigSnapshot).not.toHaveBeenCalled();
    expect(mocks.getRuntimeConfigSourceSnapshot).not.toHaveBeenCalled();
  });

  it("dedupes concurrent message.action requests while inflight", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const actionDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockReturnValueOnce(actionDeferred.promise);

    const firstRequest = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "slack",
        action: "poll",
        params: { question: "Q?" },
        idempotencyKey: "idem-action-concurrent",
      } as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });

    const secondRequest = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "slack",
        action: "poll",
        params: { question: "Q?" },
        idempotencyKey: "idem-action-concurrent",
      } as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "2", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    });

    actionDeferred.resolve({ details: { action: "handled" } });
    await Promise.all([firstRequest, secondRequest]);

    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    expect(firstRespond).toHaveBeenCalledTimes(1);
    expect(secondRespond).toHaveBeenCalledTimes(1);
    const firstCall = firstRespondCall(firstRespond);
    expect(firstCall?.[0]).toBe(true);
    expect(firstCall?.[1]).toEqual({ action: "handled" });
    expect(firstCall?.[2]).toBeUndefined();
    expect(firstCall?.[3]?.channel).toBe("slack");
    expect(firstCall?.[3]?.cached).toBeUndefined();
    const secondCall = firstRespondCall(secondRespond);
    expect(secondCall?.[0]).toBe(true);
    expect(secondCall?.[1]).toEqual({ action: "handled" });
    expect(secondCall?.[2]).toBeUndefined();
    expect(secondCall?.[3]?.channel).toBe("slack");
    expect(secondCall?.[3]?.cached).toBe(true);
  });

  it("does not share message.action idempotency results across authority origins", async () => {
    const context = makeContext();
    const directRespond = vi.fn();
    const delegatedRespond = vi.fn();
    const firstDeferred = createDeferred<{ details: { action: string } }>();
    const secondDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);
    const params = {
      channel: "slack",
      action: "read",
      params: { channelId: "C1", limit: 1 },
      idempotencyKey: "idem-action-mixed-authority",
    };

    const directRequest = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        ...params,
        conversationReadOrigin: "direct-operator",
      } as never,
      respond: directRespond,
      context,
      req: { type: "req", id: "direct", method: "message.action" },
      client: null as never,
      isWebchatConnect: () => false,
    });
    const delegatedRequest = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: params as never,
      respond: delegatedRespond,
      context,
      req: { type: "req", id: "delegated", method: "message.action" },
      client: directCliClient() as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(2);
    });
    expect(mocks.dispatchChannelMessageAction.mock.calls[0]?.[0]).toMatchObject({
      conversationReadOrigin: "direct-operator",
    });
    expect(mocks.dispatchChannelMessageAction.mock.calls[1]?.[0]).toMatchObject({
      conversationReadOrigin: "delegated",
    });

    firstDeferred.resolve({ details: { action: "direct" } });
    secondDeferred.resolve({ details: { action: "delegated" } });
    await Promise.all([directRequest, delegatedRequest]);
    expect(firstRespondCall(directRespond)?.[1]).toEqual({ action: "direct" });
    expect(firstRespondCall(delegatedRespond)?.[1]).toEqual({ action: "delegated" });
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("does not share message.action idempotency results across authenticated senders", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const firstDeferred = createDeferred<{ details: { action: string } }>();
    const secondDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockImplementation(() =>
      mocks.dispatchChannelMessageAction.mock.calls.length === 1
        ? firstDeferred.promise
        : secondDeferred.promise,
    );
    const sessionKey = "agent:main:slack:channel:C1";
    const params = {
      channel: "slack",
      action: "read",
      params: { channelId: "C1", limit: 1 },
      sessionKey,
      agentId: "main",
      idempotencyKey: "idem-action-two-senders",
    };
    const handler = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    );

    const firstRequest = handler({
      params: params as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "first", method: "message.action" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });
    const secondRequest = handler({
      params: params as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "second", method: "message.action" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-2" }) as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalled();
    });
    firstDeferred.resolve({ details: { action: "first-sender" } });
    secondDeferred.resolve({ details: { action: "second-sender" } });
    await Promise.all([firstRequest, secondRequest]);

    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(firstRespond)?.[1]).toEqual({ action: "first-sender" });
    expect(firstRespondCall(secondRespond)?.[1]).toEqual({ action: "second-sender" });
  });

  it("replays message.action results for the same authority and request semantics", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const changedRespond = vi.fn();
    const changedDeliveryContextRespond = vi.fn();
    const sessionKey = "agent:main:slack:channel:C1";
    const handler = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
      details: { action: "same-sender" },
    });
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
      details: { action: "changed-request" },
    });
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
      details: { action: "changed-delivery-context" },
    });
    const client = () => senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" });
    const commonParams = {
      channel: "slack",
      action: "read",
      sessionKey,
      agentId: "main",
      idempotencyKey: "idem-action-same-sender",
    };

    await handler({
      params: {
        ...commonParams,
        params: { channelId: "C1", limit: 1 },
      } as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "first", method: "message.action" },
      client: client() as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: {
        ...commonParams,
        params: { limit: 1, channelId: "C1" },
      } as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "second", method: "message.action" },
      client: client() as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: {
        ...commonParams,
        params: { channelId: "C1", limit: 2 },
      } as never,
      respond: changedRespond,
      context,
      req: { type: "req", id: "changed", method: "message.action" },
      client: client() as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: {
        ...commonParams,
        params: { channelId: "C1", limit: 1 },
      } as never,
      respond: changedDeliveryContextRespond,
      context,
      req: { type: "req", id: "changed-delivery-context", method: "message.action" },
      client: senderAgentRuntimeClient({
        sessionKey,
        senderId: "maintainer-1",
        sourceReplyFinal: false,
        sourceReplyToolCallId: "tool-2",
      }) as never,
      isWebchatConnect: () => false,
    });

    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(3);
    expect(firstRespondCall(firstRespond)?.[1]).toEqual({ action: "same-sender" });
    expect(firstRespondCall(secondRespond)?.[1]).toEqual({ action: "same-sender" });
    expect(firstRespondCall(secondRespond)?.[3]?.cached).toBe(true);
    expect(firstRespondCall(changedRespond)?.[1]).toEqual({ action: "changed-request" });
    expect(firstRespondCall(changedRespond)?.[3]?.cached).toBeUndefined();
    expect(firstRespondCall(changedDeliveryContextRespond)?.[1]).toEqual({
      action: "changed-delivery-context",
    });
    expect(firstRespondCall(changedDeliveryContextRespond)?.[3]?.cached).toBeUndefined();
  });

  it("keeps an agent runtime delegated even with a direct-operator marker", async () => {
    const sessionKey = "agent:main:slack:channel:C1";
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce({
      details: { action: "handled" },
    });

    await runMessageActionRequest(
      {
        channel: "slack",
        action: "read",
        params: { channelId: "C1", limit: 1 },
        sessionKey,
        agentId: "main",
        conversationReadOrigin: "direct-operator",
        idempotencyKey: "idem-agent-cli-identity",
      },
      {
        ...directCliClient(),
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: messageActionContextFromSessionKeyForTests(sessionKey),
          },
        },
      },
    );

    expect(lastDispatchChannelMessageActionCall()?.conversationReadOrigin).toBe("delegated");
  });

  it("dedupes concurrent send requests while inflight", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const sessionKey = "agent:main:slack:channel:C1";
    const deliveryDeferred = createDeferred<Array<{ messageId: string; channel: string }>>();
    mocks.deliverOutboundPayloads.mockReturnValueOnce(deliveryDeferred.promise);

    const firstRequest = expectDefined(
      sendHandlers.send,
      "sendHandlers.send test invariant",
    )({
      params: {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        sessionKey,
        agentId: "main",
        idempotencyKey: "idem-send-concurrent",
      } as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "1", method: "send" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });

    const secondRequest = expectDefined(
      sendHandlers.send,
      "sendHandlers.send test invariant",
    )({
      params: {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        sessionKey,
        agentId: "main",
        idempotencyKey: "idem-send-concurrent",
      } as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "2", method: "send" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    });

    deliveryDeferred.resolve([{ messageId: "m-concurrent", channel: "slack" }]);
    await Promise.all([firstRequest, secondRequest]);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(firstRespond).toHaveBeenCalledTimes(1);
    expect(secondRespond).toHaveBeenCalledTimes(1);
    const firstCall = firstRespondCall(firstRespond);
    expect(firstCall?.[0]).toBe(true);
    expect(firstCall?.[1]?.messageId).toBe("m-concurrent");
    expect(firstCall?.[1]?.runId).toBe("idem-send-concurrent");
    expect(firstCall?.[2]).toBeUndefined();
    expect(firstCall?.[3]?.channel).toBe("slack");
    expect(firstCall?.[3]?.cached).toBeUndefined();
    const secondCall = firstRespondCall(secondRespond);
    expect(secondCall?.[0]).toBe(true);
    expect(secondCall?.[1]?.messageId).toBe("m-concurrent");
    expect(secondCall?.[1]?.runId).toBe("idem-send-concurrent");
    expect(secondCall?.[2]).toBeUndefined();
    expect(secondCall?.[3]?.channel).toBe("slack");
    expect(secondCall?.[3]?.cached).toBe(true);
  });

  it("does not replay cached send results across authenticated senders", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const replayRespond = vi.fn();
    const secondRespond = vi.fn();
    const sessionKey = "agent:main:slack:channel:C1";
    const handler = expectDefined(sendHandlers.send, "sendHandlers.send test invariant");
    const params = {
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      sessionKey,
      agentId: "main",
      idempotencyKey: "idem-send-two-senders",
    };
    mocks.deliverOutboundPayloads
      .mockResolvedValueOnce([{ messageId: "m-first-sender", channel: "slack" }])
      .mockResolvedValueOnce([{ messageId: "m-second-sender", channel: "slack" }]);

    await handler({
      params: params as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "first", method: "send" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: params as never,
      respond: replayRespond,
      context,
      req: { type: "req", id: "replay", method: "send" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: params as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "second", method: "send" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-2" }) as never,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(firstRespond)?.[1]?.messageId).toBe("m-first-sender");
    expect(firstRespondCall(replayRespond)?.[1]?.messageId).toBe("m-first-sender");
    expect(firstRespondCall(replayRespond)?.[3]?.cached).toBe(true);
    expect(firstRespondCall(secondRespond)?.[1]?.messageId).toBe("m-second-sender");
    expect(firstRespondCall(secondRespond)?.[3]?.cached).toBeUndefined();
  });

  it("isolates device-less operator send dedupe by connection", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const replayRespond = vi.fn();
    const secondRespond = vi.fn();
    const handler = expectDefined(sendHandlers.send, "sendHandlers.send test invariant");
    const params = {
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-send-device-less-operator",
    };
    mocks.deliverOutboundPayloads
      .mockResolvedValueOnce([{ messageId: "m-connection-a", channel: "slack" }])
      .mockResolvedValueOnce([{ messageId: "m-connection-b", channel: "slack" }]);

    await handler({
      params: params as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "first", method: "send" },
      client: deviceLessOperatorClient("conn-a") as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: params as never,
      respond: replayRespond,
      context,
      req: { type: "req", id: "replay", method: "send" },
      client: deviceLessOperatorClient("conn-a") as never,
      isWebchatConnect: () => false,
    });
    await handler({
      params: params as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "second", method: "send" },
      client: deviceLessOperatorClient("conn-b") as never,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(firstRespond)?.[1]?.messageId).toBe("m-connection-a");
    expect(firstRespondCall(replayRespond)?.[1]?.messageId).toBe("m-connection-a");
    expect(firstRespondCall(replayRespond)?.[3]?.cached).toBe(true);
    expect(firstRespondCall(secondRespond)?.[1]?.messageId).toBe("m-connection-b");
    expect(firstRespondCall(secondRespond)?.[3]?.cached).toBeUndefined();
  });

  it("dedupes concurrent poll requests while inflight", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const sessionKey = "agent:main:slack:channel:C1";
    const pollDeferred = createDeferred<{ messageId: string; pollId: string }>();
    mocks.sendPoll.mockReturnValueOnce(pollDeferred.promise);

    const firstRequest = expectDefined(
      sendHandlers.poll,
      "sendHandlers.poll test invariant",
    )({
      params: {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-concurrent",
      } as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "1", method: "poll" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });

    const secondRequest = expectDefined(
      sendHandlers.poll,
      "sendHandlers.poll test invariant",
    )({
      params: {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-concurrent",
      } as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "2", method: "poll" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.sendPoll).toHaveBeenCalledTimes(1);
    });

    pollDeferred.resolve({ messageId: "poll-concurrent", pollId: "poll-1" });
    await Promise.all([firstRequest, secondRequest]);

    expect(mocks.sendPoll).toHaveBeenCalledTimes(1);
    expect(firstRespond).toHaveBeenCalledTimes(1);
    expect(secondRespond).toHaveBeenCalledTimes(1);
    const firstCall = firstRespondCall(firstRespond);
    expect(firstCall?.[0]).toBe(true);
    expect(firstCall?.[1]?.messageId).toBe("poll-concurrent");
    expect(firstCall?.[1]?.pollId).toBe("poll-1");
    expect(firstCall?.[1]?.runId).toBe("idem-poll-concurrent");
    expect(firstCall?.[2]).toBeUndefined();
    expect(firstCall?.[3]?.channel).toBe("slack");
    expect(firstCall?.[3]?.cached).toBeUndefined();
    const secondCall = firstRespondCall(secondRespond);
    expect(secondCall?.[0]).toBe(true);
    expect(secondCall?.[1]?.messageId).toBe("poll-concurrent");
    expect(secondCall?.[1]?.pollId).toBe("poll-1");
    expect(secondCall?.[1]?.runId).toBe("idem-poll-concurrent");
    expect(secondCall?.[2]).toBeUndefined();
    expect(secondCall?.[3]?.channel).toBe("slack");
    expect(secondCall?.[3]?.cached).toBe(true);
  });

  it("does not join inflight poll requests across authenticated senders", async () => {
    const context = makeContext();
    const firstRespond = vi.fn();
    const replayRespond = vi.fn();
    const secondRespond = vi.fn();
    const sessionKey = "agent:main:slack:channel:C1";
    const firstDeferred = createDeferred<{ messageId: string; pollId: string }>();
    const secondDeferred = createDeferred<{ messageId: string; pollId: string }>();
    mocks.sendPoll.mockImplementation(() =>
      mocks.sendPoll.mock.calls.length === 1 ? firstDeferred.promise : secondDeferred.promise,
    );
    const handler = expectDefined(sendHandlers.poll, "sendHandlers.poll test invariant");
    const params = {
      to: "channel:C1",
      question: "Q?",
      options: ["A", "B"],
      channel: "slack",
      idempotencyKey: "idem-poll-two-senders",
    };

    const firstRequest = handler({
      params: params as never,
      respond: firstRespond,
      context,
      req: { type: "req", id: "first", method: "poll" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });
    const secondRequest = handler({
      params: params as never,
      respond: secondRespond,
      context,
      req: { type: "req", id: "second", method: "poll" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-2" }) as never,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.sendPoll).toHaveBeenCalled();
    });
    firstDeferred.resolve({ messageId: "poll-first-sender", pollId: "poll-1" });
    secondDeferred.resolve({ messageId: "poll-second-sender", pollId: "poll-2" });
    await Promise.all([firstRequest, secondRequest]);
    await handler({
      params: params as never,
      respond: replayRespond,
      context,
      req: { type: "req", id: "replay", method: "poll" },
      client: senderAgentRuntimeClient({ sessionKey, senderId: "maintainer-1" }) as never,
      isWebchatConnect: () => false,
    });

    expect(mocks.sendPoll).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(firstRespond)?.[1]?.messageId).toBe("poll-first-sender");
    expect(firstRespondCall(replayRespond)?.[1]?.messageId).toBe("poll-first-sender");
    expect(firstRespondCall(replayRespond)?.[3]?.cached).toBe(true);
    expect(firstRespondCall(secondRespond)?.[1]?.messageId).toBe("poll-second-sender");
  });

  it("accepts media-only sends without message", async () => {
    mockDeliverySuccess("m-media");

    const { respond } = await runSend({
      to: "channel:C1",
      mediaUrl: "https://example.com/a.png",
      channel: "slack",
      idempotencyKey: "idem-media-only",
    });

    expect(deliveryCall()?.payloads).toEqual([
      { text: "", mediaUrl: "https://example.com/a.png", mediaUrls: undefined },
    ]);
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-media");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("passes outbound session context for gateway media sends", async () => {
    mockDeliverySuccess("m-whatsapp-media");

    await runSend({
      to: "+15551234567",
      message: "caption",
      mediaUrl: "file:///tmp/workspace/photo.png",
      channel: "whatsapp",
      agentId: "work",
      idempotencyKey: "idem-whatsapp-media",
    });

    expect(deliveryCall()?.channel).toBe("whatsapp");
    expect(deliveryCall()?.payloads).toEqual([
      {
        text: "caption",
        mediaUrl: "file:///tmp/workspace/photo.png",
        mediaUrls: undefined,
      },
    ]);
    expect(deliveryCall()?.session?.agentId).toBe("work");
    expect(deliveryCall()?.session?.key).toBe("agent:work:whatsapp:resolved");
  });

  it("materializes buffer-only gateway sends before outbound delivery", async () => {
    mockDeliverySuccess("m-buffer-media");

    await withTempOpenClawStateDir(async () => {
      const { respond } = await runSend({
        to: "+15551234567",
        mediaUrl: "buffer://message-send/attachment",
        mediaUrls: ["buffer://message-send/attachment"],
        buffer: Buffer.from("gateway send bytes").toString("base64"),
        filename: "gateway-send.txt",
        contentType: "text/plain",
        channel: "whatsapp",
        agentId: "work",
        idempotencyKey: "idem-whatsapp-buffer",
      });

      expect(firstRespondCall(respond)[0]).toBe(true);
      const payload = deliveryCall()?.payloads?.[0];
      expect(typeof payload?.mediaUrl).toBe("string");
      expect(payload?.mediaUrls).toEqual([payload?.mediaUrl]);
      expect(payload?.mediaUrl).not.toBe("buffer://message-send/attachment");
      await expect(fs.readFile(String(payload?.mediaUrl), "utf8")).resolves.toBe(
        "gateway send bytes",
      );
      expect(deliveryCall()?.session?.agentId).toBe("work");
    });
  });

  it("maps gateway asVoice sends onto outbound audioAsVoice payloads", async () => {
    mockDeliverySuccess("m-voice");

    const { respond } = await runSend({
      to: "channel:C1",
      message: "voice note",
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      asVoice: true,
      channel: "slack",
      idempotencyKey: "idem-voice",
    });

    expect(deliveryCall()?.payloads?.[0]?.text).toBe("voice note");
    expect(deliveryCall()?.payloads?.[0]?.mediaUrl).toBe("file:///tmp/openclaw-voice.ogg");
    expect(deliveryCall()?.payloads?.[0]?.audioAsVoice).toBe(true);
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-voice");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("forwards gateway client scopes into outbound delivery", async () => {
    mockDeliverySuccess("m-scope");

    await runSendWithClient(
      {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-scope",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(deliveryCall()?.channel).toBe("slack");
    expect(deliveryCall()?.gatewayClientScopes).toEqual(["operator.write"]);
    expect(deliveryCall()?.effectAuthorizationScope).toBe("message-action");
  });

  it("authorizes the canonical direct send as the authenticated Gateway operator", async () => {
    let seenRequest: unknown;
    let seenContext: unknown;
    installGatewayMessageActionPolicy((request, authorization) => {
      seenRequest = request;
      seenContext = authorization;
      return { effect: "pass" };
    });
    mockDeliverySuccess("m-authorized");

    const { respond } = await runSendWithClient(
      {
        to: "channel:C1",
        message: "hello",
        channel: "slack",
        idempotencyKey: "idem-authorized",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenRequest).toMatchObject({
      operation: "message.action",
      action: "send",
      channel: "slack",
      target: "resolved",
      input: { channel: "slack", to: "resolved", message: "hello" },
    });
    expect(seenContext).toMatchObject({
      principal: {
        kind: "operator",
        scopes: ["operator.write"],
        isOwner: false,
      },
      conversationId: "resolved",
      trigger: "gateway",
    });
  });

  it("dispatches a detached direct-send snapshot after caller mutation", async () => {
    const authorizationEntered = createDeferred<void>();
    const releaseAuthorization = createDeferred<void>();
    installGatewayMessageActionPolicy(async () => {
      authorizationEntered.resolve();
      await releaseAuthorization.promise;
      return { effect: "pass" };
    });
    mockDeliverySuccess("m-snapshot");
    const mediaUrls = ["https://example.test/before.png"];
    const request = {
      to: "channel:C1",
      message: "hello",
      mediaUrls,
      channel: "slack",
      idempotencyKey: "idem-authorized-snapshot",
    };

    const pending = runSendWithClient(request, {
      connect: { scopes: ["operator.write"] },
    });
    await authorizationEntered.promise;
    mediaUrls[0] = "https://example.test/after.png";
    releaseAuthorization.resolve();
    await pending;

    const delivery = deliveryCall();
    expect(delivery?.payloads).toEqual([
      expect.objectContaining({ mediaUrls: ["https://example.test/before.png"] }),
    ]);
    expect(delivery?.effectAuthorization.authorizedPayload).toEqual(
      expect.objectContaining({ mediaUrls: ["https://example.test/before.png"] }),
    );
    expect(delivery?.effectAuthorization.authorizedPayload).not.toBe(delivery?.payloads[0]);
  });

  it("reauthorizes the final Gateway payload and returns a generic nested denial", async () => {
    const seenRequests: Array<Record<string, any>> = [];
    const seenContexts: AuthorizationInvocationContext[] = [];
    installGatewayMessageActionPolicy((request, authorization) => {
      seenRequests.push(request as unknown as Record<string, any>);
      seenContexts.push(authorization);
      return request.input.payload &&
        typeof request.input.payload === "object" &&
        !Array.isArray(request.input.payload) &&
        request.input.payload.text === "forbidden"
        ? { effect: "deny", code: "private-final-payload-policy-code" }
        : { effect: "pass" };
    });
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (delivery) => {
      const effectAuthorization = (delivery as Record<string, any>).effectAuthorization;
      try {
        await effectAuthorization.authorizeChangedPayload({
          text: "forbidden",
          channelData: { marker: "final" },
        });
      } catch (error) {
        throw new OutboundEffectAuthorizationError("Outbound effect authorization rejected", error);
      }
      throw new Error("Expected final payload authorization to deny");
    });
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "allowed",
        channel: "discord",
        sessionKey,
        idempotencyKey: "idem-final-payload-denial",
      },
      senderAgentRuntimeClient({ sessionKey }),
    );

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[1]).toMatchObject({
      operation: "message.action",
      action: "send",
      input: {
        message: "forbidden",
        payload: {
          text: "forbidden",
          channelData: { marker: "final" },
        },
        channelData: { marker: "final" },
      },
    });
    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[1]).toMatchObject({
      principal: { kind: "sender", senderId: "maintainer-1" },
      conversationId: "source-C1",
    });
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]?.message).toBe("Message action blocked by authorization policy.");
    expect(JSON.stringify(response)).not.toContain("private-final-payload-policy-code");
  });

  it("delivers after an allowed final Gateway payload rewrite", async () => {
    const seenPayloads: unknown[] = [];
    installGatewayMessageActionPolicy((request) => {
      seenPayloads.push(request.input.payload);
      return { effect: "pass" };
    });
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (delivery) => {
      const effectAuthorization = (delivery as Record<string, any>).effectAuthorization;
      await effectAuthorization.authorizeChangedPayload({ text: "rewritten" });
      return [{ messageId: "m-final-rewrite", channel: "slack" }];
    });

    const { respond } = await runSendWithClient(
      {
        to: "channel:C1",
        message: "original",
        channel: "slack",
        idempotencyKey: "idem-final-payload-allowed",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(seenPayloads).toEqual([{ text: "original" }, { text: "rewritten" }]);
    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(firstRespondCall(respond)?.[1]?.messageId).toBe("m-final-rewrite");
  });

  it("authorizes a signed direct send as its source channel sender", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return authorization.principal.kind === "sender"
        ? { effect: "pass" }
        : { effect: "deny", code: "sender-required" };
    });
    mockDeliverySuccess("m-signed-sender");
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "discord",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-signed-sender",
      },
      senderAgentRuntimeClient({
        sessionKey,
        sourceConversationId: "source-C1",
        sourceThreadId: "thread-1",
      }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenContext).toMatchObject({
      principal: {
        kind: "sender",
        provider: "slack",
        accountId: "ops",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "main",
      sessionKey,
      conversationId: "source-C1",
      threadId: "thread-1",
      trigger: "gateway",
    });
  });

  it("blocks a delegated sessions_send announce as its restricted source sender", async () => {
    let seenRequest: unknown;
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((request, authorization) => {
      seenRequest = request;
      seenContext = authorization;
      return authorization.principal.kind === "sender" &&
        authorization.principal.senderId === "restricted-maintainer"
        ? { effect: "deny", code: "restricted-announce" }
        : { effect: "pass" };
    });
    const sessionKey = "agent:worker:discord:channel:target-C2";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "announce result",
        channel: "discord",
        agentId: "worker",
        sessionKey,
        idempotencyKey: "idem-delegated-announce-denied",
      },
      delegatedSenderAgentRuntimeClient({
        agentId: "worker",
        sessionKey,
        sourceConversationId: "channel:maintenance",
      }),
    );

    expect(seenRequest).toMatchObject({
      operation: "message.action",
      action: "send",
      channel: "discord",
      target: "resolved",
    });
    expect(seenContext).toMatchObject({
      principal: {
        kind: "sender",
        senderId: "restricted-maintainer",
        senderIsOwner: false,
      },
      agentId: "worker",
      sessionKey,
      conversationId: "channel:maintenance",
      threadId: "source-thread",
      trigger: "sessions_send",
    });
    expect(firstRespondCall(respond)?.[0]).toBe(false);
    expect(firstRespondCall(respond)?.[2]?.message).toBe(
      "Message action blocked by authorization policy.",
    );
    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("delivers a delegated sessions_send announce only for the exact authorized target", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((request, authorization) => {
      seenContext = authorization;
      return request.action === "send" &&
        request.channel === "discord" &&
        request.target === "resolved" &&
        authorization.agentId === "worker" &&
        authorization.sessionKey === "agent:worker:discord:channel:target-C2" &&
        authorization.conversationId === "channel:maintenance"
        ? { effect: "pass" }
        : { effect: "deny", code: "delegated-target-mismatch" };
    });
    mockDeliverySuccess("m-delegated-announce");
    const sessionKey = "agent:worker:discord:channel:target-C2";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "announce result",
        channel: "discord",
        agentId: "worker",
        sessionKey,
        idempotencyKey: "idem-delegated-announce-allowed",
      },
      delegatedSenderAgentRuntimeClient({
        agentId: "worker",
        sessionKey,
        sourceConversationId: "channel:maintenance",
      }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(seenContext?.principal).toMatchObject({
      kind: "sender",
      senderId: "restricted-maintainer",
      senderIsOwner: false,
    });
  });

  it("does not substitute a direct-send target for missing signed source context", async () => {
    let seenRequest: unknown;
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((request, authorization) => {
      seenRequest = request;
      seenContext = authorization;
      return { effect: "pass" };
    });
    mockDeliverySuccess("m-opaque-signed-sender");
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "discord",
        threadId: "target-thread-2",
        sessionKey,
        idempotencyKey: "idem-opaque-signed-sender",
      },
      senderAgentRuntimeClient({ sessionKey, omitToolContext: true }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenRequest).toMatchObject({
      operation: "message.action",
      channel: "discord",
      target: "resolved",
      threadId: "target-thread-2",
    });
    expect(seenContext?.principal).toMatchObject({
      kind: "sender",
      senderId: "maintainer-1",
    });
    expect(seenContext?.principal).not.toHaveProperty("provider");
    expect(seenContext).not.toHaveProperty("conversationId");
    expect(seenContext).not.toHaveProperty("threadId");
  });

  it("keeps signed agent runtime calls without sender provenance as service calls", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return { effect: "pass" };
    });
    mockDeliverySuccess("m-signed-service");
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "slack",
        sessionKey,
        idempotencyKey: "idem-signed-service",
      },
      senderAgentRuntimeClient({
        sessionKey,
        senderId: null,
        parentConversationId: "C-parent",
      }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenContext).toMatchObject({
      principal: { kind: "service", serviceId: "agent-runtime" },
      agentId: "main",
      sessionKey,
      conversationId: "source-C1",
      parentConversationId: "C-parent",
    });
  });

  it("derives omitted direct-send routing identity from the signed runtime", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return { effect: "pass" };
    });
    mockDeliverySuccess("m-signed-route");
    const sessionKey = "agent:work:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "discord",
        idempotencyKey: "idem-signed-route",
      },
      senderAgentRuntimeClient({ agentId: "work", sessionKey }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", currentSessionKey: sessionKey }),
    );
    expect(deliveryCall()?.session).toMatchObject({ agentId: "work", key: sessionKey });
    expect(seenContext).toMatchObject({ agentId: "work", sessionKey });
  });

  it("rejects expired signed direct-send provenance before delivery", async () => {
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "slack",
        sessionKey,
        idempotencyKey: "idem-expired-signed-send",
      },
      senderAgentRuntimeClient({ sessionKey, expiresAtMs: Date.now() - 1 }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(false);
    expect(firstRespondCall(respond)?.[2]?.message).toContain("agent runtime context has expired");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("rejects signed direct-send identity mismatches before delivery", async () => {
    const identitySessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runSendWithClient(
      {
        to: "channel:target-C2",
        message: "hello",
        channel: "slack",
        agentId: "other",
        sessionKey: "agent:other:slack:channel:source-C1",
        idempotencyKey: "idem-mismatched-signed-send",
      },
      senderAgentRuntimeClient({ sessionKey: identitySessionKey }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(false);
    expect(firstRespondCall(respond)?.[2]?.message).toContain(
      "agent runtime identity does not match the requested session",
    );
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("returns a generic denial before a direct Gateway message action dispatch", async () => {
    installGatewayMessageActionPolicy(() => ({
      effect: "deny",
      code: "private-policy-detail",
    }));

    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        action: "read",
        params: { channelId: "C1", limit: 1 },
        idempotencyKey: "idem-policy-denial",
      },
      directCliClient() as never,
    );

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]?.message).toBe("Message action blocked by authorization policy.");
    expect(JSON.stringify(response)).not.toContain("private-policy-detail");
  });

  it("authorizes delegated Gateway message actions as the signed channel sender", async () => {
    let seenContext: unknown;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return { effect: "pass" };
    });

    const sessionKey = "agent:main:slack:channel:C1";
    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        action: "read",
        params: { channelId: "C1", limit: 1 },
        sessionKey,
        sessionId: "session-1",
        idempotencyKey: "idem-sender-authorization",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-1",
              requesterAccountId: "ops",
              requesterSenderId: "maintainer-1",
              requesterSenderIsOwner: false,
              requesterIsAuthorizedSender: true,
              requesterRoleIds: ["maintainers"],
              parentConversationId: "C-parent",
              toolContext: {
                currentChannelProvider: "slack",
                currentChannelId: "C1",
                currentChatType: "channel",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenContext).toMatchObject({
      principal: {
        kind: "sender",
        provider: "slack",
        accountId: "ops",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      sessionKey: "agent:main:slack:channel:C1",
      sessionId: "session-1",
      conversationId: "C1",
      parentConversationId: "C-parent",
      trigger: "gateway",
    });
  });

  it("derives delegated message-action ownership only from the resolved principal", async () => {
    const sessionKey = "agent:main:slack:channel:C1";
    const runtimeClient = (params: {
      principal: "service" | "sender";
      senderIsOwner?: boolean;
      scopes: string[];
    }): TestGatewayClient => ({
      connect: { scopes: params.scopes },
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey,
          gatewayMethods: ["message.action"],
          messageActionContext: {
            expiresAtMs: Date.now() + 60_000,
            ...(params.principal === "sender"
              ? {
                  turnAuthority: createTurnAuthoritySnapshot({
                    principal: {
                      kind: "sender",
                      provider: "slack",
                      accountId: "ops",
                      senderId: "maintainer-1",
                      senderIsOwner: params.senderIsOwner === true,
                    },
                    agentId: "main",
                    sessionKey,
                    conversationId: "C1",
                  }),
                }
              : {}),
          },
        },
      },
    });
    const cases: Array<{
      name: string;
      client: TestGatewayClient;
      requestOwner: boolean;
      expectedOwner: boolean;
    }> = [
      {
        name: "admin operator",
        client: { connect: { scopes: ["operator.admin"] } },
        requestOwner: false,
        expectedOwner: true,
      },
      {
        name: "write operator",
        client: { connect: { scopes: ["operator.write"] } },
        requestOwner: true,
        expectedOwner: false,
      },
      {
        name: "service runtime over admin transport",
        client: runtimeClient({ principal: "service", scopes: ["operator.admin"] }),
        requestOwner: true,
        expectedOwner: false,
      },
      {
        name: "non-owner sender over admin transport",
        client: runtimeClient({
          principal: "sender",
          senderIsOwner: false,
          scopes: ["operator.admin"],
        }),
        requestOwner: true,
        expectedOwner: false,
      },
      {
        name: "owner sender over write transport",
        client: runtimeClient({
          principal: "sender",
          senderIsOwner: true,
          scopes: ["operator.write"],
        }),
        requestOwner: false,
        expectedOwner: true,
      },
    ];

    for (const testCase of cases) {
      mocks.dispatchChannelMessageAction.mockClear();
      const isRuntime = Boolean(testCase.client.internal?.agentRuntimeIdentity);
      const { respond } = await runMessageActionRequest(
        {
          channel: "slack",
          action: "react",
          params: { channelId: "C1", messageId: "m-1", emoji: "ok" },
          senderIsOwner: testCase.requestOwner,
          ...(isRuntime ? { sessionKey, agentId: "main" } : {}),
          idempotencyKey: `idem-owner-${testCase.name}`,
        },
        testCase.client,
      );

      expect(firstRespondCall(respond)[0], testCase.name).toBe(true);
      expect(lastDispatchChannelMessageActionCall()?.senderIsOwner, testCase.name).toBe(
        testCase.expectedOwner,
      );
    }
  });

  it("never trusts a request session id omitted from signed runtime provenance", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return { effect: "pass" };
    });

    const sessionKey = "agent:main:slack:channel:C1";
    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        action: "read",
        params: { channelId: "C1", limit: 1 },
        sessionKey,
        sessionId: "request-controlled-session",
        idempotencyKey: "idem-unbound-runtime-session",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              requesterSenderId: "maintainer-1",
              toolContext: {
                currentChannelProvider: "slack",
                currentChannelId: "C1",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenContext).toMatchObject({
      principal: { kind: "sender", senderId: "maintainer-1" },
      sessionKey,
    });
    expect(seenContext?.sessionId).toBeUndefined();
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined }),
    );
  });

  it("runs a signed broadcast inside the Gateway instead of dispatching one plugin action", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    const plugin = createOutboundTestPlugin({
      id: "directchat",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn(),
      },
    });
    plugin.config = { ...plugin.config, listAccountIds: () => ["default"] };
    const otherPlugin = createOutboundTestPlugin({
      id: "otherchat",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn(),
      },
    });
    otherPlugin.config = { ...otherPlugin.config, listAccountIds: () => ["default"] };
    const registry = createTestRegistry(
      [plugin, otherPlugin].map((entry) => ({
        pluginId: entry.id,
        source: "test",
        plugin: entry,
      })),
    );
    registry.authorizationPolicies.push({
      pluginId: "gateway-broadcast-policy-test",
      pluginName: "Gateway broadcast policy test",
      origin: "workspace",
      source: "test",
      policy: {
        id: "gateway-broadcast-policy-test",
        description: "Tests Gateway broadcast ownership",
        handlers: {
          "message.action": (_request, authorization) => {
            seenContext = authorization;
            return { effect: "pass" };
          },
        },
      },
    });
    setActivePluginRegistry(registry, "gateway-broadcast-test");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "directchat",
      configured: ["directchat"],
    });
    mocks.deliverOutboundPayloads.mockImplementation(async (delivery) => {
      const effectAuthorization = (delivery as Record<string, any>).effectAuthorization;
      await effectAuthorization.waitForAuthorizationBarrier({
        status: "sealed",
        digest: "sha256:test-broadcast-digest",
        handle: null,
      });
      return [{ messageId: "gateway-broadcast-message", channel: "directchat" }];
    });
    const cfg = {
      channels: {
        directchat: { enabled: true },
        otherchat: { enabled: true },
      },
      tools: {
        message: {
          broadcast: { enabled: true },
          crossContext: { allowAcrossProviders: true },
        },
      },
    };
    const context = {
      ...makeContext(),
      getRuntimeConfig: () => cfg,
    } as unknown as GatewayRequestContext;
    const sessionKey = "agent:main:slack:channel:C1";
    const respond = vi.fn();

    await expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "directchat",
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        sessionKey,
        sessionId: "session-1",
        agentId: "main",
        idempotencyKey: "idem-gateway-broadcast",
      } as never,
      respond,
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: senderAgentRuntimeClient({ sessionKey, sessionId: "session-1" }) as never,
      isWebchatConnect: () => false,
    });

    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]).toMatchObject({
      results: [{ channel: "directchat", ok: true }],
    });
    expect(response?.[1]?.results).toHaveLength(1);
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(deliveryCall()?.mirror?.idempotencyKey).toBe("idem-gateway-broadcast");
    expect(seenContext).toMatchObject({
      principal: { kind: "sender", senderId: "maintainer-1" },
      conversationId: "source-C1",
      trigger: "gateway",
    });
  });

  it("rejects an unauthenticated Gateway broadcast before any channel effect", async () => {
    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        idempotencyKey: "idem-unauthenticated-broadcast",
      },
      null,
    );

    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]?.message).toContain("authenticated runtime or operator");
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not copy target provider or account onto a source-opaque sender principal", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((_request, authorization) => {
      seenContext = authorization;
      return { effect: "pass" };
    });
    const sessionKey = "agent:main:slack:channel:C1";

    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        accountId: "target-account",
        action: "read",
        params: { channelId: "C1", limit: 1 },
        sessionKey,
        sessionId: "session-1",
        idempotencyKey: "idem-opaque-sender-source",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-1",
              requesterSenderId: "maintainer-1",
              toolContext: { currentChannelId: "C1", currentChatType: "channel" },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenContext?.principal).toEqual({
      kind: "sender",
      senderId: "maintainer-1",
    });
    expect(seenContext?.principal).not.toHaveProperty("provider");
    expect(seenContext?.principal).not.toHaveProperty("accountId");
  });

  it("forwards an empty gateway scope array into outbound delivery", async () => {
    mockDeliverySuccess("m-empty-scope");

    await runSendWithClient(
      {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-empty-scope",
      },
      { connect: { scopes: [] } },
    );

    expect(deliveryCall()?.channel).toBe("slack");
    expect(deliveryCall()?.gatewayClientScopes).toEqual([]);
  });

  it("rejects empty sends when neither text nor media is present", async () => {
    const { respond } = await runSend({
      to: "channel:C1",
      message: "   ",
      channel: "slack",
      idempotencyKey: "idem-empty",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.message).toContain("text or media is required");
  });

  it("returns actionable guidance when channel is internal webchat", async () => {
    const { respond } = await runSend({
      to: "x",
      message: "hi",
      channel: "webchat",
      idempotencyKey: "idem-webchat",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.message).toContain("unsupported channel: webchat");
    expect(response?.[2]?.message).toContain("Use `chat.send`");
  });

  it("accepts bundled channels before plugin registry normalization for message actions", async () => {
    const { respond } = await runMessageActionRequest({
      channel: "TELEGRAM",
      action: "send",
      params: { target: "123", message: "hi" },
      idempotencyKey: "idem-telegram-message-action",
    });

    const call = lastDispatchChannelMessageActionCall();
    expect(call?.channel).toBe("telegram");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("rejects unknown send channels without delivering", async () => {
    mocks.getChannelPlugin.mockReturnValue(undefined);

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      channel: "definitely-not-a-real-channel-xyz",
      idempotencyKey: "idem-unknown-channel",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]?.message).toContain(
      "unsupported channel: definitely-not-a-real-channel-xyz",
    );
  });

  it("auto-picks the single configured channel for send", async () => {
    mockDeliverySuccess("m-single-send");

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-single-send");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("auto-picks the single configured channel from the auto-enabled config snapshot for send", async () => {
    const autoEnabledConfig = { channels: { slack: {} }, plugins: { allow: ["slack"] } };
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    mockDeliverySuccess("m-single-send-auto");

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel-auto-enabled",
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
    });
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-single-send-auto");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("returns invalid request when send channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel-ambiguous",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.message).toContain("Channel is required");
  });

  it("forwards gateway client scopes into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-scope",
      },
      { connect: { scopes: ["operator.admin"] } },
    );

    const call = pollCall();
    if (call.cfg === undefined) {
      throw new Error("Expected poll delivery config");
    }
    expect(call.to).toBe("resolved");
    expect(call.gatewayClientScopes).toEqual(["operator.admin"]);
  });

  it("authorizes a signed poll as its source channel sender", async () => {
    let seenRequest: unknown;
    let seenContext: AuthorizationInvocationContext | undefined;
    installGatewayMessageActionPolicy((request, authorization) => {
      seenRequest = request;
      seenContext = authorization;
      return authorization.principal.kind === "sender"
        ? { effect: "pass" }
        : { effect: "deny", code: "sender-required" };
    });
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runPollWithClient(
      {
        to: "channel:target-C2",
        question: "Q?",
        options: ["A", "B"],
        channel: "discord",
        threadId: "target-thread-2",
        idempotencyKey: "idem-signed-poll",
      },
      senderAgentRuntimeClient({
        sessionKey,
        sourceConversationId: "source-C1",
      }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(seenRequest).toMatchObject({
      operation: "message.action",
      channel: "discord",
      threadId: "target-thread-2",
    });
    expect(seenContext).toMatchObject({
      principal: {
        kind: "sender",
        provider: "slack",
        senderId: "maintainer-1",
        roleIds: ["maintainers"],
      },
      agentId: "main",
      sessionKey,
      conversationId: "source-C1",
    });
    expect(seenContext).not.toHaveProperty("threadId");
  });

  it("rejects expired signed poll provenance before delivery", async () => {
    const sessionKey = "agent:main:slack:channel:source-C1";

    const { respond } = await runPollWithClient(
      {
        to: "channel:target-C2",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-expired-signed-poll",
      },
      senderAgentRuntimeClient({ sessionKey, expiresAtMs: Date.now() - 1 }),
    );

    expect(firstRespondCall(respond)?.[0]).toBe(false);
    expect(firstRespondCall(respond)?.[2]?.message).toContain("agent runtime context has expired");
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("forwards an empty gateway scope array into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-empty-scope",
      },
      { connect: { scopes: [] } },
    );

    const call = pollCall();
    if (call.cfg === undefined) {
      throw new Error("Expected poll delivery config");
    }
    expect(call.to).toBe("resolved");
    expect(call.gatewayClientScopes).toEqual([]);
  });

  it("includes optional poll delivery identifiers in the gateway payload", async () => {
    mocks.sendPoll.mockResolvedValue({
      messageId: "poll-rich",
      channelId: "C123",
      conversationId: "conv-1",
      toJid: "jid-1",
      pollId: "poll-meta-1",
    });

    const { respond } = await runPoll({
      to: "channel:C1",
      question: "Q?",
      options: ["A", "B"],
      channel: "slack",
      idempotencyKey: "idem-poll-rich",
    });

    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]).toEqual({
      runId: "idem-poll-rich",
      messageId: "poll-rich",
      channel: "slack",
      channelId: "C123",
      conversationId: "conv-1",
      toJid: "jid-1",
      pollId: "poll-meta-1",
    });
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("auto-picks the single configured channel for poll", async () => {
    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response[0]).toBe(true);
    if (response[1] === undefined) {
      throw new Error("Expected poll missing-channel response payload");
    }
    expect(response[2]).toBeUndefined();
    expect(response[3]).toEqual({ channel: "slack" });
  });

  it("returns invalid request when poll channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel-ambiguous",
    });

    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.message).toContain("Channel is required");
  });

  it("does not mirror when delivery returns no results", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-1",
      sessionKey: "agent:main:main",
    });

    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:main");
  });

  it("mirrors media filenames when delivery succeeds", async () => {
    mockDeliverySuccess("m1");

    await runSend({
      to: "channel:C1",
      message: "caption",
      mediaUrl: "https://example.com/files/report.pdf?sig=1",
      channel: "slack",
      idempotencyKey: "idem-2",
      sessionKey: "agent:main:main",
    });

    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:main");
    expect(deliveryCall()?.mirror?.text).toBe("caption");
    expect(deliveryCall()?.mirror?.mediaUrls).toEqual([
      "https://example.com/files/report.pdf?sig=1",
    ]);
    expect(deliveryCall()?.mirror?.idempotencyKey).toBe("idem-2");
  });

  it("mirrors MEDIA tags as attachments", async () => {
    mockDeliverySuccess("m2");

    await runSend({
      to: "channel:C1",
      message: "Here\nMEDIA:https://example.com/image.png",
      channel: "slack",
      idempotencyKey: "idem-3",
      sessionKey: "agent:main:main",
    });

    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:main");
    expect(deliveryCall()?.mirror?.text).toBe("Here");
    expect(deliveryCall()?.mirror?.mediaUrls).toEqual(["https://example.com/image.png"]);
  });

  it("lowercases provided session keys for mirroring", async () => {
    mockDeliverySuccess("m-lower");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-lower",
      sessionKey: "agent:main:slack:channel:C123",
    });

    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123");
  });

  it("derives a target session key when none is provided", async () => {
    mockDeliverySuccess("m3");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      idempotencyKey: "idem-4",
    });

    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:slack:channel:resolved");
    expect(deliveryCall()?.mirror?.agentId).toBe("main");
  });

  it("uses explicit agentId for delivery when sessionKey is not provided", async () => {
    mockDeliverySuccess("m-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      idempotencyKey: "idem-agent-explicit",
    });

    expect(deliveryCall()?.session?.agentId).toBe("work");
    expect(deliveryCall()?.session?.key).toBe("agent:work:slack:channel:resolved");
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:work:slack:channel:resolved");
    expect(deliveryCall()?.mirror?.agentId).toBe("work");
  });

  it("uses sessionKey agentId when explicit agentId is omitted", async () => {
    mockDeliverySuccess("m-session-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-session-agent",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("rejects a missing reserved agent-harness session before persistence or delivery", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing";

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey,
      idempotencyKey: "idem-missing-agent-harness-session",
    });

    const response = firstRespondCall(respond);
    expect(response[0]).toBe(false);
    expect(response[2]?.message).toBe(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("allows delivery through an existing reserved agent-harness session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing";
    mocks.loadSessionEntry.mockReturnValueOnce({
      canonicalKey: sessionKey,
      entry: { sessionId: "native-session" },
    });
    mockDeliverySuccess("m-existing-agent-harness-session");

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey,
      idempotencyKey: "idem-existing-agent-harness-session",
    });

    const response = firstRespondCall(respond);
    expect(response[0]).toBe(true);
    expect(ensureSessionEntryCall()?.route?.sessionKey).toBe(sessionKey);
    expectDeliverySessionMirror({ agentId: "main", sessionKey });
  });

  it("still resolves outbound routing metadata when a sessionKey is provided", async () => {
    mockDeliverySuccess("m-matrix-session-route");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });

    await runSend({
      to: "@alice:example.org",
      message: "hello",
      channel: "matrix",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      idempotencyKey: "idem-matrix-session-route",
    });

    expect(outboundRouteCall()?.channel).toBe("matrix");
    expect(outboundRouteCall()?.target).toBe("resolved");
    expect(outboundRouteCall()?.currentSessionKey).toBe(
      "agent:main:matrix:channel:!dm:example.org",
    );
    expect(ensureSessionEntryCall()?.route?.sessionKey).toBe(
      "agent:main:matrix:channel:!dm:example.org",
    );
    expect(ensureSessionEntryCall()?.route?.baseSessionKey).toBe(
      "agent:main:matrix:channel:!dm:example.org",
    );
    expect(ensureSessionEntryCall()?.route?.to).toBe("room:!dm:example.org");
    expectDeliverySessionMirror({
      agentId: "main",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
    });
  });

  it("falls back to the provided sessionKey when outbound route lookup returns null", async () => {
    mockDeliverySuccess("m-session-fallback");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-session-fallback",
    });

    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(deliveryCall()?.session?.agentId).toBe("work");
    expect(deliveryCall()?.session?.key).toBe("agent:work:slack:channel:c1");
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:work:slack:channel:c1");
    expect(deliveryCall()?.mirror?.agentId).toBe("work");
  });

  it("prefers explicit agentId over sessionKey agent for delivery and mirror", async () => {
    mockDeliverySuccess("m-agent-precedence");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-agent-precedence",
    });

    expect(deliveryCall()?.session?.agentId).toBe("work");
    expect(deliveryCall()?.session?.key).toBe("agent:main:slack:channel:c1");
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:slack:channel:c1");
    expect(deliveryCall()?.mirror?.agentId).toBe("work");
  });

  it("ignores blank explicit agentId and falls back to sessionKey agent", async () => {
    mockDeliverySuccess("m-agent-blank");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "   ",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-agent-blank",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("forwards threadId to outbound delivery when provided", async () => {
    mockDeliverySuccess("m-thread");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread",
    });

    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
  });

  it("forwards gateway send delivery options to outbound delivery", async () => {
    mockDeliverySuccess("m-options");

    await runSend({
      to: "channel:C1",
      message: "<b>report</b>",
      channel: "slack",
      forceDocument: true,
      silent: true,
      parseMode: "HTML",
      idempotencyKey: "idem-send-options",
    });

    const options = mocks.deliverOutboundPayloads.mock.calls.at(0)?.[0];
    expect(options?.forceDocument).toBe(true);
    expect(options?.silent).toBe(true);
    expect(options?.formatting).toEqual({ parseMode: "HTML" });
  });

  it("updates mirror session keys and delivery thread ids when Slack routing derives a thread", async () => {
    mockDeliverySuccess("m-thread-derived");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c1",
      peer: { kind: "channel", id: "c1" },
      chatType: "channel",
      from: "slack:channel:C1",
      to: "channel:C1",
      threadId: "1710000000.9999",
    });

    await runSend({
      to: "channel:C1",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-thread-derived",
    });

    expect(ensureSessionEntryCall()?.route?.sessionKey).toBe(
      "agent:main:slack:channel:c1:thread:1710000000.9999",
    );
    expect(ensureSessionEntryCall()?.route?.baseSessionKey).toBe("agent:main:slack:channel:c1");
    expect(ensureSessionEntryCall()?.route?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.mirror?.sessionKey).toBe(
      "agent:main:slack:channel:c1:thread:1710000000.9999",
    );
  });

  it("preserves the provided session when Slack derives a thread for a different base session", async () => {
    mockDeliverySuccess("m-thread-mismatch");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:slack:channel:c2:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c2",
      peer: { kind: "channel", id: "c2" },
      chatType: "channel",
      from: "slack:channel:C2",
      to: "channel:C2",
      threadId: "1710000000.9999",
    });

    await runSend({
      to: "channel:C2",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread-mismatch",
    });

    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.session?.key).toBe("agent:main:slack:channel:c1");
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:slack:channel:c1");
  });

  it("preserves derived thread delivery for existing thread-scoped Slack session keys", async () => {
    mockDeliverySuccess("m-thread-session");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c1",
      peer: { kind: "channel", id: "c1" },
      chatType: "channel",
      from: "slack:channel:C1",
      to: "channel:C1",
      threadId: "1710000000.9999",
    });

    await runSend({
      to: "channel:C1",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      idempotencyKey: "idem-thread-session",
    });

    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.session?.key).toBe("agent:main:slack:channel:c1:thread:1710000000.9999");
  });

  it("preserves numeric derived thread ids for non-Slack channels", async () => {
    mockDeliverySuccess("m-topic-derived");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:telegram:group:-100123:thread:77",
      baseSessionKey: "agent:main:telegram:group:-100123",
      peer: { kind: "group", id: "-100123" },
      chatType: "group",
      from: "telegram:group:-100123",
      to: "channel:-100123",
      threadId: 77,
    });

    await runSend({
      to: "-100123:topic:77",
      message: "topic message",
      channel: "telegram",
      idempotencyKey: "idem-topic-derived",
    });

    expect(deliveryCall()?.threadId).toBe(77);
  });

  it("returns invalid request when outbound target resolution fails", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: false,
      error: new Error("target not found"),
    });

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-target-fail",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.message).toContain("target not found");
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("recovers cold plugin resolution for threaded sends", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.deliverOutboundPayloads.mockResolvedValue([
      { messageId: "m-threaded", channel: "slack" },
    ]);
    const outboundPlugin = { outbound: { sendPoll: mocks.sendPoll } };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(outboundPlugin)
      .mockReturnValue(outboundPlugin);

    const { respond } = await runSend({
      to: "123",
      message: "threaded completion",
      channel: "slack",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-cold-thread",
    });

    expect(deliveryCall()?.channel).toBe("slack");
    expect(deliveryCall()?.to).toBe("123");
    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-threaded");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("forwards replyToId on gateway sends", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId: "m-reply", channel: "slack" }]);
    const outboundPlugin = { outbound: { sendPoll: mocks.sendPoll } };
    mocks.getChannelPlugin.mockReturnValue(outboundPlugin);

    const { respond } = await runSend({
      to: "123",
      message: "threaded completion",
      channel: "slack",
      replyToId: "wamid.42",
      idempotencyKey: "idem-reply-to",
    });

    expect(deliveryCall()?.channel).toBe("slack");
    expect(deliveryCall()?.to).toBe("123");
    expect(deliveryCall()?.replyToId).toBe("wamid.42");
    expect(outboundRouteCall()?.channel).toBe("slack");
    expect(outboundRouteCall()?.target).toBe("123");
    expect(outboundRouteCall()?.replyToId).toBe("wamid.42");
    const response = firstRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.messageId).toBe("m-reply");
    expect(response?.[2]).toBeUndefined();
    expect(response?.[3]?.channel).toBe("slack");
  });

  it("dispatches message actions through the gateway for plugin-owned channels", async () => {
    const reactPlugin: ChannelPlugin = {
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct"], reactions: true },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["react"] }),
        supportsAction: ({ action }) => action === "react",
        handleAction: async ({ params, requesterAccountId, requesterSenderId, toolContext }) =>
          jsonResult({
            ok: true,
            messageId: params.messageId,
            requesterAccountId,
            requesterSenderId,
            currentMessageId: toolContext?.currentMessageId,
            currentChatType: toolContext?.currentChatType,
            currentMessagingTarget: toolContext?.currentMessagingTarget,
            currentGraphChannelId: toolContext?.currentGraphChannelId,
            replyToMode: toolContext?.replyToMode,
            hasRepliedRef: toolContext?.hasRepliedRef?.value,
            sameChannelThreadRequired: toolContext?.sameChannelThreadRequired,
            skipCrossContextDecoration: toolContext?.skipCrossContextDecoration,
          }),
      },
    };
    mocks.getChannelPlugin.mockReturnValue(reactPlugin);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: reactPlugin,
        },
      ]),
      "send-test-message-action",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({
        ok: true,
        messageId: "wamid.1",
        requesterAccountId: "default",
        requesterSenderId: "trusted-user",
        currentMessageId: "wamid.1",
        currentChatType: "direct",
        currentMessagingTarget: "user:15551234567",
        currentGraphChannelId: "graph:team/chan",
        replyToMode: "first",
        hasRepliedRef: true,
        sameChannelThreadRequired: true,
        skipCrossContextDecoration: true,
      }),
    );

    const sessionKey = "agent:main:whatsapp:direct:15551234567";
    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "react",
        params: {
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "✅",
        },
        requesterAccountId: "default",
        requesterSenderId: "trusted-user",
        inboundTurnKind: "room_event",
        sessionKey,
        agentId: "main",
        toolContext: {
          currentMessagingTarget: "user:15551234567",
          currentGraphChannelId: "graph:team/chan",
          currentChannelProvider: "whatsapp",
          currentMessageId: "wamid.1",
          replyToMode: "first",
          hasRepliedRef: { value: true },
          sameChannelThreadRequired: true,
          skipCrossContextDecoration: true,
        },
        idempotencyKey: "idem-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              requesterAccountId: "default",
              requesterSenderId: "trusted-user",
              toolContext: {
                currentChannelProvider: "whatsapp",
                currentChannelId: "15551234567",
                currentChatType: "direct",
                currentMessagingTarget: "user:15551234567",
                currentGraphChannelId: "graph:team/chan",
                currentMessageId: "wamid.1",
                replyToMode: "first",
                hasRepliedRef: { value: true },
                sameChannelThreadRequired: true,
                skipCrossContextDecoration: true,
              },
            },
          },
        },
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        messageId: "wamid.1",
        requesterAccountId: "default",
        requesterSenderId: "trusted-user",
        currentMessageId: "wamid.1",
        currentChatType: "direct",
        currentMessagingTarget: "user:15551234567",
        currentGraphChannelId: "graph:team/chan",
        replyToMode: "first",
        hasRepliedRef: true,
        sameChannelThreadRequired: true,
        skipCrossContextDecoration: true,
      },
      undefined,
      { channel: "whatsapp" },
    );
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundEventKind: "room_event",
        requesterAccountId: "default",
        toolContext: expect.objectContaining({
          currentChatType: "direct",
          currentMessagingTarget: "user:15551234567",
        }),
      }),
    );
  });

  it("strips current-turn context from unauthenticated message action callers", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      actions: {
        handleAction: vi.fn(),
      },
    });
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(jsonResult({ ok: true }));

    const { respond } = await runMessageActionRequest({
      channel: "whatsapp",
      action: "react",
      params: { messageId: "wamid.1", emoji: "ok" },
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentChannelId: "user:15551234567",
      },
      idempotencyKey: "idem-untrusted-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAccountId: undefined,
        requesterSenderId: undefined,
        toolContext: undefined,
      }),
    );
  });

  it("strips forged current-turn context from agent runs without an ingress capability", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      actions: {
        handleAction: vi.fn(),
      },
    });
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(jsonResult({ ok: true }));

    const sessionKey = "agent:main:whatsapp:direct:alice";
    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "react",
        params: { messageId: "wamid.1", emoji: "ok" },
        requesterAccountId: "default",
        requesterSenderId: "forged-sender",
        sessionKey,
        agentId: "main",
        toolContext: {
          currentChannelProvider: "whatsapp",
          currentChannelId: "user:alice",
        },
        idempotencyKey: "idem-forged-agent-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAccountId: undefined,
        requesterSenderId: undefined,
        toolContext: undefined,
      }),
    );
  });

  it("rejects ingress-issued message action context for a different session", async () => {
    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "react",
        params: { messageId: "wamid.1", emoji: "ok" },
        sessionKey: "agent:main:whatsapp:direct:bob",
        agentId: "main",
        toolContext: {
          currentChannelProvider: "whatsapp",
          currentChannelId: "user:bob",
        },
        idempotencyKey: "idem-mismatched-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:whatsapp:direct:alice",
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              toolContext: {
                currentChannelProvider: "whatsapp",
                currentChannelId: "user:alice",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "agent runtime identity does not match the requested session",
    );
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it("rejects ingress-issued message action context after expiry", async () => {
    const sessionKey = "agent:main:whatsapp:direct:alice";
    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "react",
        params: { messageId: "wamid.1", emoji: "ok" },
        sessionKey,
        agentId: "main",
        idempotencyKey: "idem-expired-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() - 1,
              toolContext: {
                currentChannelProvider: "whatsapp",
                currentChannelId: "user:alice",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain("agent runtime context has expired");
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it("mirrors successful source-conversation message.action sends into the assistant transcript", async () => {
    const telegramPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram source send transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-1" }),
      },
      threading: {
        resolveCurrentChannelId: ({ to, threadId }) =>
          threadId == null ? to : `${to}:topic:${threadId}`,
      },
    };
    mocks.getChannelPlugin.mockReturnValue(telegramPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      "send-test-source-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-1" }),
    );

    const sessionKey = "agent:main:telegram:direct:chat-123";
    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: "visible source reply",
        },
        sessionKey,
        sessionId: "session-1",
        agentId: "main",
        idempotencyKey: "idem-source-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-1",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-1",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentMessageId: "telegram-message-1",
                currentSourceTurnId: "channel-user:v1:telegram-message-1",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:chat-123",
      expectedSessionId: "session-1",
      text: "visible source reply",
      mediaUrls: undefined,
      idempotencyKey:
        "idem-source-message-action:terminal-receipt:channel-user:v1:telegram-message-1",
      deliveryMirror: {
        kind: "message-tool-source-reply",
        final: true,
        sourceTurnId: "channel-user:v1:telegram-message-1",
        toolCallId: "message-call-1",
      },
      config: {},
    });
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey,
        sourceTurnId: "channel-user:v1:telegram-message-1",
        toolCallId: "message-call-1",
      }),
    );
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey,
        sourceTurnId: "channel-user:v1:telegram-message-1",
        toolCallId: "message-call-1",
      }),
    );
    expect(
      expectDefined(
        mocks.beginRestartRecoveryTerminalDelivery.mock.invocationCallOrder[0],
        "expected terminal intent order",
      ),
    ).toBeLessThan(
      expectDefined(
        mocks.dispatchChannelMessageAction.mock.invocationCallOrder[0],
        "expected provider dispatch order",
      ),
    );
    expect(
      expectDefined(
        mocks.dispatchChannelMessageAction.mock.invocationCallOrder[0],
        "expected provider dispatch order",
      ),
    ).toBeLessThan(
      expectDefined(
        mocks.completeRestartRecoveryTerminalDelivery.mock.invocationCallOrder[0],
        "expected terminal completion order",
      ),
    );
  });

  it("uses a distinct transcript receipt key after progress with the same send key", async () => {
    mocks.dispatchChannelMessageAction
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-progress" }))
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-terminal" }));
    const sessionKey = "agent:main:telegram:direct:chat-123";
    const identity = (sourceReplyFinal: boolean) => ({
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime" as const,
          agentId: "main",
          sessionKey,
          messageActionContext: {
            expiresAtMs: Date.now() + 60_000,
            sessionId: "session-shared-key",
            sourceReplyFinal,
            sourceReplyToolCallId: sourceReplyFinal
              ? "message-call-shared-terminal"
              : "message-call-shared-progress",
            toolContext: {
              currentChannelProvider: "telegram",
              currentChannelId: "chat-123",
              currentSourceTurnId: "channel-user:v1:shared-key",
            },
          },
        },
      },
    });
    const request = (message: string) => ({
      channel: "telegram",
      action: "send",
      params: { to: "chat-123", message },
      sessionKey,
      sessionId: "session-shared-key",
      agentId: "main",
      idempotencyKey: "idem-shared-source-message-action",
    });

    await runMessageActionRequest(request("progress"), identity(false));
    await runMessageActionRequest(request("terminal"), identity(true));

    expect(mocks.appendAssistantMessageToSessionTranscript.mock.calls).toHaveLength(2);
    expect(appendTranscriptCall(0)?.idempotencyKey).toBe("idem-shared-source-message-action");
    expect(appendTranscriptCall(1)?.idempotencyKey).toBe(
      "idem-shared-source-message-action:terminal-receipt:channel-user:v1:shared-key",
    );
  });

  it("rejects a terminal source send without tool-call correlation before dispatch", async () => {
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "uncorrelated terminal" },
        sessionKey,
        sessionId: "session-uncorrelated-terminal",
        agentId: "main",
        idempotencyKey: "idem-uncorrelated-terminal",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-uncorrelated-terminal",
              sourceReplyFinal: true,
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:uncorrelated-terminal",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "terminal source reply requires tool-call correlation",
    );
    expect(mocks.beginRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("does not retry a delivered terminal reply when receipt finalization fails", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-ambiguous-receipt" }),
    );
    mocks.completeRestartRecoveryTerminalDelivery.mockRejectedValueOnce(
      new Error("receipt store unavailable"),
    );
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "delivered with pending receipt" },
        sessionKey,
        sessionId: "session-ambiguous-receipt",
        agentId: "main",
        idempotencyKey: "idem-ambiguous-receipt",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-ambiguous-receipt",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-ambiguous",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:ambiguous-receipt",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
  });

  it("blocks a repeated terminal send before provider dispatch", async () => {
    mocks.beginRestartRecoveryTerminalDelivery.mockResolvedValueOnce("blocked");
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "duplicate terminal" },
        sessionKey,
        sessionId: "session-duplicate-terminal",
        agentId: "main",
        idempotencyKey: "idem-duplicate-terminal",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-duplicate-terminal",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-duplicate",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:duplicate-terminal",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it("sends a terminal source reply when the live turn has no recovery claim", async () => {
    mocks.beginRestartRecoveryTerminalDelivery.mockResolvedValueOnce("not-applicable");
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-live-unclaimed" }),
    );
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "live terminal" },
        sessionKey,
        sessionId: "session-live-unclaimed",
        agentId: "main",
        idempotencyKey: "idem-live-unclaimed",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-live-unclaimed",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-live-unclaimed",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:live-unclaimed",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledOnce();
    expect(mocks.completeRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
  });

  it("keeps the provider receipt durable when transcript mirroring is rejected", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-2" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      code: "blocked",
      reason: "transcript write rejected",
    });
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "delivered but unrecorded" },
        sessionKey,
        sessionId: "session-2",
        agentId: "main",
        idempotencyKey: "idem-source-message-action-2",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-2",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-2",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:telegram-message-2",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-2",
        sessionKey,
        sourceTurnId: "channel-user:v1:telegram-message-2",
      }),
    );
  });

  it("records terminal delivery even when its payload has no transcript projection", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-unmirrorable" }),
    );
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          presentation: { blocks: [{ type: "divider" }] },
        },
        sessionKey,
        sessionId: "session-unmirrorable",
        agentId: "main",
        idempotencyKey: "idem-unmirrorable-source-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-unmirrorable",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-unmirrorable",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:telegram-message-unmirrorable",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-unmirrorable",
        sessionKey,
        sourceTurnId: "channel-user:v1:telegram-message-unmirrorable",
      }),
    );
  });

  it("keeps a diverted terminal send fail closed instead of claiming a source reply", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, result: { messageId: "tg-diverted", receipt: {} } }),
    );
    const sessionKey = "agent:main:telegram:group:chat-123:topic:77";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "diverted terminal" },
        sessionKey,
        sessionId: "session-diverted",
        agentId: "main",
        idempotencyKey: "idem-diverted-terminal",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-diverted",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-diverted",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentThreadTs: "77",
                currentSourceTurnId: "channel-user:v1:diverted-terminal",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.completeRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("mirrors a Slack DM send after target resolution strips its user prefix", async () => {
    const slackPlugin: ChannelPlugin = {
      id: "slack",
      meta: {
        id: "slack",
        label: "Slack",
        selectionLabel: "Slack",
        docsPath: "/channels/slack",
        blurb: "Slack DM transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "slack-1" }),
      },
      threading: {
        matchesToolContextTarget: ({ target, toolContext }) =>
          target.toLowerCase() ===
          toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
      },
    };
    mocks.getChannelPlugin.mockReturnValue(slackPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
      "send-test-slack-dm-source-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockImplementationOnce(async ({ params }) => {
      params.to = "U123";
      return jsonResult({
        ok: true,
        result: {
          messageId: "slack-1",
          receipt: { threadId: "171.222" },
        },
      });
    });

    const { respond } = await runMessageActionRequest({
      channel: "slack",
      action: "send",
      params: {
        to: "user:U123",
        message: "visible Slack DM reply",
      },
      sessionKey: "agent:main:slack:direct:U123:thread:171.222",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentThreadTs: "171.222",
        replyToMode: "all",
      },
      idempotencyKey: "idem-slack-dm-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:slack:direct:U123:thread:171.222",
      text: "visible Slack DM reply",
      mediaUrls: undefined,
      idempotencyKey: "idem-slack-dm-source-message-action",
      config: {},
    });

    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    for (const testCase of [
      {
        name: "top-level",
        placement: { topLevel: true },
        deliveredThreadId: undefined,
        replyToMode: "all" as const,
        hasRepliedRef: undefined,
      },
      {
        name: "null thread",
        placement: { threadId: null },
        deliveredThreadId: undefined,
        replyToMode: "all" as const,
        hasRepliedRef: undefined,
      },
      {
        name: "different thread",
        placement: { threadId: "999.888" },
        deliveredThreadId: "999.888",
        replyToMode: "all" as const,
        hasRepliedRef: undefined,
      },
      {
        name: "reply mode off",
        placement: {},
        deliveredThreadId: undefined,
        replyToMode: "off" as const,
        hasRepliedRef: undefined,
      },
      {
        name: "consumed first reply",
        placement: {},
        deliveredThreadId: undefined,
        replyToMode: "first" as const,
        hasRepliedRef: { value: true },
      },
    ] as const) {
      mocks.dispatchChannelMessageAction.mockImplementationOnce(async ({ params }) => {
        params.to = "U123";
        return jsonResult({
          ok: true,
          result: {
            messageId: `slack-${testCase.name}`,
            receipt: testCase.deliveredThreadId ? { threadId: testCase.deliveredThreadId } : {},
          },
        });
      });

      const redirected = await runMessageActionRequest({
        channel: "slack",
        action: "send",
        params: {
          to: "user:U123",
          message: `visible Slack DM ${testCase.name} reply`,
          ...testCase.placement,
        },
        sessionKey: "agent:main:slack:direct:U123:thread:171.222",
        agentId: "main",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "D123",
          currentMessagingTarget: "user:U123",
          currentThreadTs: "171.222",
          replyToMode: testCase.replyToMode,
          ...(testCase.hasRepliedRef ? { hasRepliedRef: testCase.hasRepliedRef } : {}),
        },
        idempotencyKey: `idem-slack-dm-source-message-action-${testCase.name}`,
      });

      expect(firstRespondCall(redirected.respond)[0]).toBe(true);
      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    }
  });

  it("mirrors accepted source send text aliases", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-content-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        content: "visible content alias reply",
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-content-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:chat-123",
      text: "visible content alias reply",
      mediaUrls: undefined,
      idempotencyKey: "idem-content-source-message-action",
      config: {},
    });
  });

  it("keeps delivered source sends successful when transcript mirroring fails", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-mirror-failed" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
      new Error("transcript unavailable"),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        message: "visible source reply",
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-source-message-action-mirror-failed",
    });

    const call = firstRespondCall(respond);
    expect(call[0]).toBe(true);
    expect(call[1]).toEqual({ ok: true, messageId: "tg-mirror-failed" });
    expect(call[2]).toBeUndefined();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
  });

  it("mirrors caption-only source sends with media", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-caption-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        mediaUrl: "https://example.com/image.png",
        caption: "visible media caption",
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-caption-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:chat-123",
      text: "visible media caption",
      mediaUrls: ["https://example.com/image.png"],
      idempotencyKey: "idem-caption-source-message-action",
      config: {},
    });
  });

  it("waits for source transcript mirroring before responding to message.action", async () => {
    const telegramPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram async source send transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-async-1" }),
      },
    };
    const mirrorDeferred = createDeferred<SessionTranscriptAppendResult>();
    mocks.getChannelPlugin.mockReturnValue(telegramPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      "send-test-source-message-action-async-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-async-1" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockReturnValueOnce(mirrorDeferred.promise);

    const respond = vi.fn();
    const request = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: "visible media caption",
        },
        sessionKey: "agent:main:telegram:direct:chat-123",
        agentId: "main",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "chat-123",
        },
        idempotencyKey: "idem-async-source-message-action",
      } as never,
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "message.action" },
      client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => {
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    });
    expect(respond).not.toHaveBeenCalled();

    mirrorDeferred.resolve({ ok: true, sessionFile: "x", messageId: "message-async" });
    await request;

    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("preserves source transcript mirror order before message.action responses", async () => {
    const telegramPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram ordered async source send transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-ordered" }),
      },
    };
    const firstMirrorDeferred = createDeferred<SessionTranscriptAppendResult>();
    mocks.getChannelPlugin.mockReturnValue(telegramPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      "send-test-source-message-action-ordered-async-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValue(
      jsonResult({ ok: true, messageId: "tg-ordered" }),
    );
    mocks.appendAssistantMessageToSessionTranscript
      .mockReturnValueOnce(firstMirrorDeferred.promise)
      .mockResolvedValueOnce({ ok: true, sessionFile: "x", messageId: "message-second" });

    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const first = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: "first visible reply",
        },
        sessionKey: "agent:main:telegram:direct:chat-123",
        agentId: "main",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "chat-123",
        },
        idempotencyKey: "idem-ordered-source-message-action-1",
      } as never,
      respond: firstRespond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "message.action" },
      client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
      isWebchatConnect: () => false,
    });
    await vi.waitFor(() => {
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    });
    const second = expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: "second visible reply",
        },
        sessionKey: "agent:main:telegram:direct:chat-123",
        agentId: "main",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "chat-123",
        },
        idempotencyKey: "idem-ordered-source-message-action-2",
      } as never,
      respond: secondRespond,
      context: makeContext(),
      req: { type: "req", id: "2", method: "message.action" },
      client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
      isWebchatConnect: () => false,
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(firstRespond).not.toHaveBeenCalled();
    expect(secondRespond).not.toHaveBeenCalled();
    expect(appendTranscriptCall(0)).toEqual(
      expect.objectContaining({ text: "first visible reply" }),
    );

    firstMirrorDeferred.resolve({ ok: true, sessionFile: "x", messageId: "message-first" });
    await first;
    await second;

    expect(firstRespondCall(firstRespond)[0]).toBe(true);
    expect(firstRespondCall(secondRespond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(appendTranscriptCall(1)).toEqual(
      expect.objectContaining({ text: "second visible reply" }),
    );
  });

  it("mirrors presentation-only source-conversation message.action sends", async () => {
    const telegramPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram source send rich transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-rich-1" }),
      },
      threading: {
        resolveCurrentChannelId: ({ to, threadId }) =>
          threadId == null ? to : `${to}:topic:${threadId}`,
      },
    };
    mocks.getChannelPlugin.mockReturnValue(telegramPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      "send-test-rich-source-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-rich-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        presentation: {
          title: "Approval needed",
          blocks: [
            { type: "text", text: "Review the deployment request" },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" },
              ],
            },
          ],
        },
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-rich-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:chat-123",
      text: "Approval needed\nReview the deployment request\nApprove\nReject",
      mediaUrls: undefined,
      idempotencyKey: "idem-rich-source-message-action",
      config: {},
    });
  });

  it("mirrors title-only source-conversation presentation sends", async () => {
    const telegramPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram source send title-only transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-title-1" }),
      },
    };
    mocks.getChannelPlugin.mockReturnValue(telegramPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      "send-test-title-only-source-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-title-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        presentation: {
          title: "Title-only approval",
        },
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-title-only-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:chat-123",
      text: "Title-only approval",
      mediaUrls: undefined,
      idempotencyKey: "idem-title-only-source-message-action",
      config: {},
    });
  });

  it("mirrors auto-threaded Telegram source sends into the topic transcript", async () => {
    const telegramTopicPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram topic source send transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["group"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-topic-1" }),
      },
      threading: {
        resolveCurrentChannelId: ({ to, threadId }) =>
          threadId == null ? to : `${to}:topic:${threadId}`,
      },
    };
    mocks.getChannelPlugin.mockReturnValue(telegramTopicPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramTopicPlugin }]),
      "send-test-topic-source-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-topic-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        message: "visible topic source reply",
        messageThreadId: "77",
      },
      sessionKey: "agent:main:telegram:group:chat-123:topic:77",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123:topic:77",
        currentThreadTs: "77",
      },
      idempotencyKey: "idem-topic-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:group:chat-123:topic:77",
      text: "visible topic source reply",
      mediaUrls: undefined,
      idempotencyKey: "idem-topic-source-message-action",
      config: {},
    });
  });

  it("does not mirror topic context when delivery params target the parent chat", async () => {
    const telegramTopicPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram parent send transcript mirror test plugin.",
      },
      capabilities: { chatTypes: ["group"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true, messageId: "tg-parent-1" }),
      },
      threading: {
        resolveCurrentChannelId: ({ to, threadId }) =>
          threadId == null ? to : `${to}:topic:${threadId}`,
      },
    };
    mocks.getChannelPlugin.mockReturnValue(telegramTopicPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramTopicPlugin }]),
      "send-test-topic-context-parent-message-action-mirror",
    );
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-parent-1" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "chat-123",
        message: "visible parent source reply",
      },
      sessionKey: "agent:main:telegram:group:chat-123:topic:77",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123:topic:77",
        currentThreadTs: "77",
      },
      idempotencyKey: "idem-topic-context-parent-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("does not mirror message.action sends to a different target", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-external" }),
    );

    const { respond } = await runMessageActionRequest({
      channel: "telegram",
      action: "send",
      params: {
        to: "other-chat",
        message: "external visible reply",
      },
      sessionKey: "agent:main:telegram:direct:chat-123",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "chat-123",
      },
      idempotencyKey: "idem-external-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("does not mirror explicitly failed message.action sends", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: false, error: "delivery failed" }),
    );

    const sessionKey = "agent:main:telegram:direct:chat-123";
    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: "failed source reply",
        },
        sessionKey,
        sessionId: "session-failed",
        agentId: "main",
        idempotencyKey: "idem-failed-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-failed",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-failed",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:failed",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.completeRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
  });

  it("leaves terminal delivery pending when dispatch throws with an unknown outcome", async () => {
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(new Error("provider timeout"));
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "chat-123", message: "maybe delivered" },
        sessionKey,
        sessionId: "session-timeout",
        agentId: "main",
        idempotencyKey: "idem-timeout-message-action",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: "session-timeout",
              sourceReplyFinal: true,
              sourceReplyToolCallId: "message-call-timeout",
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: "channel-user:v1:timeout",
              },
            },
          },
        },
      },
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.completeRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media roots to gateway message actions", async () => {
    const mediaActionPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram media action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment"] }),
        supportsAction: ({ action }) => action === "sendAttachment",
        handleAction: async () => jsonResult({ ok: true }),
      },
    };
    mocks.getChannelPlugin.mockReturnValue(mediaActionPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: mediaActionPlugin }]),
      "send-test-message-action-media-roots",
    );

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "sendAttachment",
        params: { chatId: "123", mediaUrl: `${TEST_AGENT_WORKSPACE}/render.png` },
        agentId: "work",
        idempotencyKey: "idem-message-action-media-roots",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    const actionCall = lastDispatchChannelMessageActionCall();
    expect(actionCall?.mediaLocalRoots).toContain(TEST_AGENT_WORKSPACE);
    expect(actionCall?.gatewayClientScopes).toEqual(["operator.write"]);
  });

  it("materializes buffer-only message.action sends on the gateway before plugin dispatch", async () => {
    const mediaActionPlugin: ChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Telegram media action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async () => jsonResult({ ok: true }),
      },
    };
    mocks.getChannelPlugin.mockReturnValue(mediaActionPlugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: mediaActionPlugin }]),
      "send-test-message-action-buffer-materialize",
    );

    await withTempOpenClawStateDir(async () => {
      const { respond } = await runMessageActionRequest(
        {
          channel: "telegram",
          action: "send",
          params: {
            to: "123",
            media: "buffer://message-send/attachment",
            mediaUrl: "buffer://message-send/attachment",
            mediaUrls: ["buffer://message-send/attachment"],
            buffer: Buffer.from("gateway bytes").toString("base64"),
            filename: "gateway.txt",
            contentType: "text/plain",
          },
          agentId: "work",
          idempotencyKey: "idem-message-action-buffer-materialize",
        },
        { connect: { scopes: ["operator.write"] } },
      );

      expect(firstRespondCall(respond)[0]).toBe(true);
      const actionCall = lastDispatchChannelMessageActionCall();
      const actionParams = actionCall?.params;
      expect(actionParams?.buffer).toBeUndefined();
      expect(typeof actionParams?.mediaUrl).toBe("string");
      expect(actionParams?.media).toBe(actionParams?.mediaUrl);
      expect(actionParams?.mediaUrls).toEqual([actionParams?.mediaUrl]);
      await expect(fs.readFile(String(actionParams?.mediaUrl), "utf8")).resolves.toBe(
        "gateway bytes",
      );
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
