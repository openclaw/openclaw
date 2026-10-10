// Send method tests cover outbound message routing, transcript mirroring, poll
// dispatch, plugin channel selection, and durable delivery dependencies.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { resolveOutboundTargetWithPlugin } from "../../infra/outbound/targets-resolve-shared.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindInProcessSessionDeliveryGeneration } from "../in-process-session-delivery.js";
import { revokeMessageActionTurnCapability } from "../message-action-turn-capability.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";
import { startGatewayMaintenanceTimers } from "../server-maintenance.js";
import { createGatewayMaintenanceStateForTest } from "../test-helpers.maintenance-state.js";
import { registerSendDeliveryAttemptTests } from "./send.delivery-attempt.test-support.js";
import { registerSendSessionRoutingTests } from "./send.session-routing.test-support.js";
import {
  agentRuntimeClientForTests as agentRuntimeClient,
  createTelegramSourceSendRequest,
  createMessageActionTurnClientForTests,
  directCliClientForTests as directCliClient,
  firstRespondCall,
  messageActionContextFromSessionKeyForTests,
  resolveAgentIdFromSessionKeyForTests,
} from "./send.test-helpers.js";
import {
  createMessageMethodPluginFixtures,
  createMessageMethodTestDriver,
  makeContext,
} from "./send.test-support.js";
import { registerSendUploadPolicyTests } from "./send.upload-policy.test-support.js";
import type { GatewayRequestContext } from "./types.js";

type ResolveOutboundTarget = typeof import("../../infra/outbound/targets.js").resolveOutboundTarget;

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn<() => Promise<SessionTranscriptAppendResult>>(
    async () => ({
      ok: true,
      target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
      messageId: "message-x",
    }),
  ),
  beginRestartRecoveryTerminalDelivery: vi.fn<
    () => Promise<
      "started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"
    >
  >(async () => "started"),
  cancelRestartRecoveryTerminalDelivery: vi.fn(async () => "cleared" as const),
  completeRestartRecoveryTerminalDelivery: vi.fn(async () => "recorded" as const),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn<ResolveOutboundTarget>(async () => ({ ok: true, to: "resolved" })),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  dispatchChannelMessageAction: vi.fn(),
  sendPoll: vi.fn<NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>>(async () => ({
    messageId: "poll-1",
  })),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
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

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
}));

vi.mock("../../channels/plugins/message-action-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/message-action-dispatch.js")>()),
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
  prepareExternalMessageActionTargetForResolution: (ctx: { params: Record<string, unknown> }) => ({
    params: ctx.params,
  }),
  shouldDeferExternalMessageActionTargetResolution: () => false,
}));

const TEST_AGENT_WORKSPACE = "/tmp/openclaw-test-workspace";
let sendHandlers: typeof import("./send.js").sendHandlers;

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveSessionAgentId: ({
    sessionKey,
    agentId,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => resolveAgentIdFromSessionKeyForTests({ sessionKey, agentId }),
  resolveAgentConfig: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => TEST_AGENT_WORKSPACE,
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

vi.mock("../../infra/outbound/channel-bootstrap.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/channel-bootstrap.runtime.js")>()),
  bootstrapOutboundChannelPlugin: vi.fn(),
  bootstrapOutboundChannelPluginAsync: vi.fn(),
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

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

const {
  invokeGatewayMessageMethod,
  runSend,
  runSendWithClient,
  runPoll,
  runMessageActionRequest,
  runTelegramTerminalAction,
} = createMessageMethodTestDriver(() => sendHandlers);

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

function lastDispatchChannelMessageActionCall(): Record<string, any> | undefined {
  const calls = mocks.dispatchChannelMessageAction.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls.at(-1)?.[0];
}

function ensureSessionEntryCall(index = 0): Record<string, any> | undefined {
  const calls = mocks.ensureOutboundSessionEntry.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

const { registerMessageThreadAddressingPlugin, registerMessageActionPlugin } =
  createMessageMethodPluginFixtures(mocks);

async function expectRejectedSend(params: Record<string, unknown>, message: string) {
  const { respond } = await runSend({
    to: "channel:C1",
    message: "hi",
    idempotencyKey: "rejected-send",
    ...params,
  });
  const response = firstRespondCall(respond);
  expect(response[0]).toBe(false);
  expect(response[1]).toBeUndefined();
  expect(response[2]?.message).toContain(message);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return response;
}

function fixedStoreContext(): GatewayRequestContext {
  return {
    ...makeContext(),
    getRuntimeConfig: () => ({
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
    }),
  };
}

function mockMutableMessageRouteAccounts(resolveDefaultAccountId: (channel: string) => string) {
  mocks.getChannelPlugin.mockImplementation((channel: string) => ({
    id: channel,
    actions: { handleAction: true },
    outbound: { sendPoll: mocks.sendPoll },
    config: {
      listAccountIds: () => ["primary", "secondary"],
      defaultAccountId: () => resolveDefaultAccountId(channel),
      resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId, enabled: true }),
    },
  }));
}

describe("gateway send mirroring", () => {
  let registrySeq = 0;

  beforeAll(async () => {
    ({ sendHandlers } = await import("./send.js"));
    await import("../../infra/outbound/message-action-runner.js");
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `send-test-${registrySeq}`);
    mocks.getRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(null);
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: undefined,
    }));
    mocks.resolveOutboundTarget.mockResolvedValue({ ok: true, to: "resolved" });
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
    mocks.getChannelPlugin.mockImplementation((channel: string) => ({
      id: channel,
      actions: { handleAction: true },
      outbound: { sendPoll: mocks.sendPoll },
      config: {
        listAccountIds: (cfg: { channels?: Record<string, { accounts?: object }> }) => {
          const accountIds = Object.keys(cfg.channels?.[channel]?.accounts ?? {});
          return accountIds.length > 0 ? accountIds : ["default"];
        },
        resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId, enabled: true }),
      },
    }));
  });

  it.each([
    ["missing", "Unknown account"],
    ["sut", "does not match"],
  ] as const)(
    "rejects message.action account %s before provider code",
    async (accountId, expectedError) => {
      const resolveAccountAsync = vi.fn(async (_cfg: unknown, resolvedAccountId: string) => ({
        enabled: resolvedAccountId !== "disabled",
      }));
      mocks.getChannelPlugin.mockReturnValue({
        id: "slack",
        actions: { handleAction: true },
        outbound: { sendPoll: mocks.sendPoll },
        config: {
          listAccountIds: () => ["default", "sut", "disabled"],
          resolveAccountAsync,
          resolveAccount: (_cfg: unknown, resolvedAccountId: string) => ({
            enabled: resolvedAccountId !== "disabled",
          }),
        },
      });

      const { respond } = await runMessageActionRequest({
        channel: "slack",
        accountId,
        idempotencyKey: "account-selection",
        action: "send",
        params: { target: "channel:current", message: "hi", accountId: "default" },
      });
      const response = firstRespondCall(respond);
      expect(response[0]).toBe(false);
      expect(response[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(JSON.stringify(response[2])).toContain(expectedError);
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
      if (accountId === "missing") {
        expect(resolveAccountAsync).not.toHaveBeenCalled();
      }
    },
  );

  it("uses the resolved runtime config when the source snapshot matches", async () => {
    const sourceAccount = {
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN_DRCLAW" },
    } as const;
    const sourceConfig = { channels: { discord: { accounts: { drclaw: sourceAccount } } } };
    const runtimeAccount = { token: "resolved-token" };
    const runtimeConfig = {
      channels: { discord: { enabled: true, accounts: { drclaw: runtimeAccount } } },
      plugins: { allow: ["discord"] },
    };
    mocks.getRuntimeConfigSnapshot.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(sourceConfig);
    const { respond } = await runMessageActionRequest(
      {
        channel: "discord",
        action: "channel-info",
        params: { channelId: "123", accountId: "drclaw" },
        idempotencyKey: "runtime-config",
      },
      null,
      { ...makeContext(), getRuntimeConfig: () => sourceConfig },
    );
    expect(mocks.getRuntimeConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getRuntimeConfigSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(lastDispatchChannelMessageActionCall()?.cfg).toBe(runtimeConfig);
    expect(firstRespondCall(respond)[0]).toBe(true);
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

    const directRequest = invokeGatewayMessageMethod({
      method: "message.action",
      request: {
        ...params,
        conversationReadOrigin: "direct-operator",
      },
      respond: directRespond,
      context,
      requestId: "direct",
    });
    const delegatedRequest = invokeGatewayMessageMethod({
      method: "message.action",
      request: params,
      respond: delegatedRespond,
      context,
      requestId: "delegated",
      client: directCliClient() as never,
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

  it("dedupes omitted and explicit default message.action accounts", async () => {
    const context = makeContext();
    const omittedRespond = vi.fn();
    const explicitRespond = vi.fn();
    const actionDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockReturnValueOnce(actionDeferred.promise);

    const omittedRequest = invokeGatewayMessageMethod({
      method: "message.action",
      request: {
        channel: "slack",
        action: "send",
        params: { target: "channel:current", message: "hi" },
        idempotencyKey: "idem-action-effective-default",
      },
      respond: omittedRespond,
      context,
      requestId: "omitted",
    });
    const explicitRequest = invokeGatewayMessageMethod({
      method: "message.action",
      request: {
        channel: "slack",
        action: "send",
        params: { target: "channel:current", message: "hi" },
        accountId: "default",
        idempotencyKey: "idem-action-effective-default",
      },
      respond: explicitRespond,
      context,
      requestId: "explicit",
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    });
    actionDeferred.resolve({ details: { action: "handled" } });
    await Promise.all([omittedRequest, explicitRequest]);

    for (const [index, respond] of [omittedRespond, explicitRespond].entries()) {
      expect(respond).toHaveBeenCalledOnce();
      const response = firstRespondCall(respond);
      expect(response[0]).toBe(true);
      expect(response[1]).toEqual({ action: "handled" });
      expect(response[2]).toBeUndefined();
      expect(response[3]?.channel).toBe("slack");
      expect(response[3]?.cached).toBe(index === 0 ? undefined : true);
    }
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending message.action route bound through maintenance and default changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
    let defaultAccountId = "primary";
    mockMutableMessageRouteAccounts(() => defaultAccountId);
    const context = makeContext();
    const maintenance = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      dedupe: context.dedupe,
      runWorktreeGc: vi.fn(async () => undefined),
    });
    const actionDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockReturnValueOnce(actionDeferred.promise);
    const invoke = (respond: ReturnType<typeof vi.fn>) =>
      invokeGatewayMessageMethod({
        method: "message.action",
        request: {
          channel: "slack",
          action: "send",
          params: { target: "channel:current", message: "hi" },
          idempotencyKey: "idem-action-pending-maintenance",
        },
        respond,
        context,
      });

    try {
      const firstRespond = vi.fn();
      const firstRequest = invoke(firstRespond);
      await vi.waitFor(() => {
        expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
      });
      expect([...context.dedupe.keys()].some((key) => key.includes(":route-binding:"))).toBe(false);

      await vi.advanceTimersByTimeAsync(DEDUPE_TTL_MS + 60_000);
      defaultAccountId = "secondary";
      const retryRespond = vi.fn();
      const retryRequest = invoke(retryRespond);
      await vi.waitFor(() => {
        expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
      });

      actionDeferred.resolve({ details: { action: "handled" } });
      await Promise.all([firstRequest, retryRequest]);

      expect(firstRespondCall(firstRespond)?.[0]).toBe(true);
      expect(firstRespondCall(retryRespond)?.[0]).toBe(true);
      expect(firstRespondCall(retryRespond)?.[3]?.cached).toBe(true);
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    } finally {
      await maintenance.stopPeriodicTasks();
      await maintenance.skillUsageCleanup();
      vi.useRealTimers();
    }
  });

  it("does not let settled route aliases evict canonical results before ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
    let defaultAccountId = "primary";
    mockMutableMessageRouteAccounts(() => defaultAccountId);
    const context = makeContext();
    const maintenance = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      dedupe: context.dedupe,
      runWorktreeGc: vi.fn(async () => undefined),
    });
    const operationCount = Math.floor(DEDUPE_MAX / 2) + 1;
    const invoke = (idempotencyKey: string, respond: ReturnType<typeof vi.fn>) =>
      invokeGatewayMessageMethod({
        method: "message.action",
        request: {
          channel: "slack",
          action: "send",
          params: { target: "channel:current", message: "hi" },
          idempotencyKey,
        },
        respond,
        context,
      });

    try {
      for (let index = 0; index < operationCount; index += 1) {
        await invoke(`idem-action-capacity-${index}`, vi.fn());
      }

      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(operationCount);
      expect(context.dedupe.size).toBe(operationCount);
      expect([...context.dedupe.keys()].some((key) => key.includes(":route-binding:"))).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      defaultAccountId = "secondary";
      const retryRespond = vi.fn();
      await invoke("idem-action-capacity-0", retryRespond);

      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(operationCount);
      expect(firstRespondCall(retryRespond)?.[0]).toBe(true);
      expect(firstRespondCall(retryRespond)?.[3]?.cached).toBe(true);
    } finally {
      await maintenance.stopPeriodicTasks();
      await maintenance.skillUsageCleanup();
      vi.useRealTimers();
    }
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

  it("reports queue custody without advertising retryability", async () => {
    const error = new OutboundDeliveryError("connect ECONNREFUSED", {
      cause: new Error("connect ECONNREFUSED"),
      stage: "platform_send",
    });
    error.queueCustody = "held";
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(error);
    const { respond } = await runMessageActionRequest(
      {
        channel: "slack",
        action: "send",
        params: { channelId: "C1", message: "hi" },
        idempotencyKey: "queue-custody",
      },
      directCliClient(),
    );
    expect(firstRespondCall(respond)[2]).toMatchObject({
      code: ErrorCodes.UNAVAILABLE,
      details: { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED },
    });
    expect(firstRespondCall(respond)[2]?.retryable).toBeUndefined();
  });

  it.each(["delegated", "caller"] as const)(
    "does not send after %s authority closes during session preparation",
    async (authority) => {
      const preparation = createDeferred<null>();
      mocks.resolveOutboundSessionRoute.mockReturnValueOnce(preparation.promise);
      let authorityActive = true;
      const context = {
        ...makeContext(),
        validateAgentRuntimeApprovalAuthority: () => authority === "caller" || authorityActive,
      } as GatewayRequestContext;
      const request = runSendWithClient(
        {
          channel: "slack",
          to: "channel:C1",
          message: "must not escape",
          sessionKey: "agent:main:slack:channel:C1",
          idempotencyKey: "idem-send-authority-race",
        },
        agentRuntimeClient("agent:main:slack:channel:C1"),
        context,
        authority === "caller"
          ? () => {
              if (!authorityActive) {
                throw new Error("in-process caller closed");
              }
            }
          : undefined,
      );
      await vi.waitFor(() => expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledOnce());
      authorityActive = false;
      preparation.resolve(null);

      const { respond } = await request;
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    },
  );

  it("stops Telegram plugin sends when their live owner closes between deliveries", async () => {
    const { telegramMessageActions } = await loadBundledPluginFacade<{
      telegramMessageActions: NonNullable<ChannelPlugin["actions"]>;
    }>({ pluginId: "telegram", artifactBasename: "runtime-api.js" });
    const { dispatchChannelMessageAction } = await vi.importActual<
      typeof import("../../channels/plugins/message-action-dispatch.js")
    >("../../channels/plugins/message-action-dispatch.js");
    const plugin = registerMessageActionPlugin({ registrySuffix: "telegram-live-owner" });
    plugin.actions = telegramMessageActions;
    mocks.dispatchChannelMessageAction.mockImplementationOnce(dispatchChannelMessageAction);
    const firstSendStarted = createDeferred();
    const releaseFirstSend = createDeferred();
    const physicalSends: string[] = [];
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async (params: {
        onPlatformSendDispatch?: () => Promise<void>;
        assertDirectAdapterHandoff?: () => void;
      }) => {
        const results = [];
        for (const messageId of ["album", "last-photo"]) {
          await params.onPlatformSendDispatch?.();
          params.assertDirectAdapterHandoff?.();
          physicalSends.push(messageId);
          if (messageId === "album") {
            firstSendStarted.resolve();
            await releaseFirstSend.promise;
          }
          results.push({ channel: "telegram", messageId, chatId: "12345" });
        }
        return results;
      },
    );
    let authorityActive = true;
    const sessionKey = "agent:main:telegram:direct:12345";
    const request = runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "12345",
          message: "photos",
          mediaUrls: ["https://example.com/one.jpg", "https://example.com/two.jpg"],
        },
        sessionKey,
        idempotencyKey: "telegram-live-owner-revoked",
      },
      agentRuntimeClient(sessionKey),
      {
        ...makeContext(),
        getRuntimeConfig: () => ({ channels: { telegram: { botToken: "123456:fixture" } } }),
        validateAgentRuntimeApprovalAuthority: () => authorityActive,
      },
    );
    await firstSendStarted.promise;
    authorityActive = false;
    releaseFirstSend.resolve();
    const { respond } = await request;

    expect(physicalSends).toEqual(["album"]);
    expect(deliveryCall()?.skipQueue).toBe(true);
    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
  });

  it.each(["dispatch", "handoff"])(
    "does not send or queue after delegated authority closes during delivery preflight (%s)",
    async (boundary) => {
      const enteredDelivery = createDeferred<null>();
      const resumeDelivery = createDeferred<null>();
      const platformSend = vi.fn();
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async (params: {
          onPlatformSendDispatch?: () => Promise<void>;
          assertDirectAdapterHandoff?: () => void;
        }) => {
          if (boundary === "handoff") {
            await params.onPlatformSendDispatch?.();
          }
          enteredDelivery.resolve(null);
          await resumeDelivery.promise;
          if (boundary === "dispatch") {
            await params.onPlatformSendDispatch?.();
          }
          params.assertDirectAdapterHandoff?.();
          platformSend();
          return [{ channel: "slack", messageId: "must-not-send" }];
        },
      );
      let authorityActive = true;
      const context = {
        ...makeContext(),
        validateAgentRuntimeApprovalAuthority: () => authorityActive,
      } as GatewayRequestContext;
      const request = runSendWithClient(
        {
          channel: "slack",
          to: "channel:C1",
          message: "must not escape",
          sessionKey: "agent:main:slack:channel:C1",
          idempotencyKey: "idem-send-delivery-authority-race",
        },
        agentRuntimeClient("agent:main:slack:channel:C1"),
        context,
      );
      await enteredDelivery.promise;
      authorityActive = false;
      resumeDelivery.resolve(null);

      const { respond } = await request;
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
      expect(deliveryCall()?.skipQueue).toBe(true);
      expect(platformSend).not.toHaveBeenCalled();
    },
  );

  it("fences delegated reads when their originating turn closes during provider work", async () => {
    const entered = createDeferred<null>();
    const resume = createDeferred<null>();
    const providerRequest = vi.fn();
    mocks.dispatchChannelMessageAction.mockImplementationOnce(
      async (ctx: { assertDirectAdapterHandoff?: () => void }) => {
        entered.resolve(null);
        await resume.promise;
        ctx.assertDirectAdapterHandoff?.();
        providerRequest();
        return { details: { ok: true } };
      },
    );
    const sessionKey = "agent:main:slack:channel:C1";
    const { client, context, turnCapability, close } = createMessageActionTurnClientForTests({
      sessionKey,
      runId: "read-turn-revocation",
    });
    try {
      const request = runMessageActionRequest(
        {
          channel: "slack",
          action: "read",
          params: { channelId: "C2", limit: 1 },
          sessionKey,
          idempotencyKey: "read-turn-revocation",
        },
        client,
        context,
      );
      await entered.promise;
      revokeMessageActionTurnCapability(turnCapability);
      resume.resolve(null);
      const { respond } = await request;
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
      expect(providerRequest).not.toHaveBeenCalled();
    } finally {
      resume.resolve(null);
      close();
    }
  });

  registerSendDeliveryAttemptTests({ mocks, invokeGatewayMessageMethod, mockDeliverySuccess });

  it("does not send after turn capability closes while delegated authority remains active", async () => {
    const enteredDelivery = createDeferred<null>();
    const resumeDelivery = createDeferred<null>();
    const platformSend = vi.fn();
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async (params: { onPlatformSendDispatch?: () => Promise<void> }) => {
        enteredDelivery.resolve(null);
        await resumeDelivery.promise;
        await params.onPlatformSendDispatch?.();
        platformSend();
        return [{ channel: "slack", messageId: "must-not-send" }];
      },
    );
    const sessionKey = "agent:main:slack:channel:C1";
    const {
      client,
      context,
      turnCapability: messageActionTurnCapability,
      close,
    } = createMessageActionTurnClientForTests({
      sessionKey,
      runId: "run-turn-capability-race",
    });

    try {
      const request = runSendWithClient(
        {
          channel: "slack",
          to: "channel:C1",
          message: "must not escape",
          sessionKey,
          idempotencyKey: "idem-send-turn-capability-race",
        },
        client,
        context,
      );
      await enteredDelivery.promise;
      expect(revokeMessageActionTurnCapability(messageActionTurnCapability)).toBe(true);
      resumeDelivery.resolve(null);

      const { respond } = await request;
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
      expect(platformSend).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("cancels a prepared terminal receipt when authority closes before action dispatch", async () => {
    const receipt = createDeferred<"started">();
    mocks.beginRestartRecoveryTerminalDelivery.mockReturnValueOnce(receipt.promise);
    let authorityActive = true;
    const context = {
      ...makeContext(),
      validateAgentRuntimeApprovalAuthority: () => authorityActive,
    } as GatewayRequestContext;
    const request = runTelegramTerminalAction({
      sessionId: "session-authority-race",
      idempotencyKey: "idem-action-authority-race",
      sourceTurnId: "channel-user:v1:authority-race",
      toolCallId: "tool-authority-race",
      message: "must not escape",
      context,
    });
    await vi.waitFor(() =>
      expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce(),
    );
    authorityActive = false;
    receipt.resolve("started");

    const { respond } = await request;
    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
    expect(mocks.cancelRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it("keeps the first deferred send route when a retry sees newer defaults", async () => {
    const firstSelection = createDeferred<{ channel: string; configured: string[] }>();
    mocks.resolveMessageChannelSelection
      .mockImplementationOnce(async () => await firstSelection.promise)
      .mockResolvedValue({ channel: "discord", configured: ["discord"] });
    mockMutableMessageRouteAccounts(() => "primary");

    const providerDeferred = createDeferred<Array<{ messageId: string; channel: string }>>();
    mocks.deliverOutboundPayloads.mockReturnValueOnce(providerDeferred.promise);
    const request = { to: "channel:C1", message: "hi", idempotencyKey: "deferred-route-race" };

    const context = makeContext();
    const firstRespond = vi.fn();
    const retryRespond = vi.fn();
    const firstRequest = invokeGatewayMessageMethod({
      method: "send",
      request,
      respond: firstRespond,
      context,
    });
    await vi.waitFor(() => {
      expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledTimes(1);
    });

    const retryRequest = invokeGatewayMessageMethod({
      method: "send",
      request,
      respond: retryRespond,
      context,
    });
    await Promise.resolve();
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledTimes(1);

    firstSelection.resolve({ channel: "slack", configured: ["slack"] });
    await vi.waitFor(() => {
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    });
    providerDeferred.resolve([{ messageId: "m-race", channel: "slack" }]);
    await Promise.all([firstRequest, retryRequest]);

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(firstRespond)?.[0]).toBe(true);
    expect(firstRespondCall(retryRespond)?.[0]).toBe(true);
    expect(firstRespondCall(retryRespond)?.[3]?.cached).toBe(true);
  });

  it("preserves authored media captions and their selected agent session", async () => {
    mockDeliverySuccess("m-whatsapp-media");

    await runSend({
      to: "+15551234567",
      message: " \tcaption  \n\n",
      mediaUrl: "file:///tmp/workspace/photo.png",
      channel: "whatsapp",
      agentId: "work",
      replyToId: "media-parent",
      idempotencyKey: "idem-whatsapp-media",
    });

    expect(deliveryCall()?.channel).toBe("whatsapp");
    expect(deliveryCall()?.replyToId).toBe("media-parent");
    expect(deliveryCall()?.payloads).toEqual([
      {
        text: " \tcaption  \n\n",
        mediaUrl: "file:///tmp/workspace/photo.png",
        mediaUrls: undefined,
      },
    ]);
    expect(deliveryCall()?.mirror?.text).toBe(" \tcaption");
    expect(deliveryCall()?.session?.agentId).toBe("work");
    expect(deliveryCall()?.session?.key).toBe("agent:work:whatsapp:resolved");
  });

  it("hands each internally bound session result to the durable queue with its original generation", async () => {
    mockDeliverySuccess("m-session-result");
    const generation = {
      agentId: "main",
      storePath: "/test/agents/main/sessions/sessions.json",
      sessionKey: "agent:main:main",
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    const { respond } = await runSend(
      bindInProcessSessionDeliveryGeneration(
        {
          channel: "telegram",
          to: "original-recipient",
          message: "Task complete",
          idempotencyKey: "sessions-send:accepted-run",
        },
        generation,
      ),
    );
    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(deliveryCall()).toMatchObject({
      sessionGeneration: generation,
      deliveryIntentId: "sessions-send:accepted-run",
      reusePendingDeliveryIntent: true,
      queuePolicy: "required",
      skipQueue: false,
    });
  });

  registerSendUploadPolicyTests({
    mocks,
    runSendWithClient,
    runMessageActionRequest,
    registerMessageActionPlugin,
    mockDeliverySuccess,
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

  it("rejects empty sends when neither text nor media is present", async () => {
    await expectRejectedSend({ channel: "slack", message: "   " }, "text or media is required");
  });

  it("returns actionable guidance when channel is internal webchat", async () => {
    const response = await expectRejectedSend(
      { channel: "webchat" },
      "unsupported channel: webchat",
    );
    expect(response[2]?.message).toContain("Use `chat.send`");
  });

  it("rejects unknown send channels without delivering", async () => {
    mocks.getChannelPlugin.mockReturnValue(undefined);
    await expectRejectedSend(
      { channel: "definitely-not-a-real-channel-xyz" },
      "unsupported channel: definitely-not-a-real-channel-xyz",
    );
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

  it("rejects outbound delivery without a result", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-1",
      sessionKey: "agent:main:main",
    });

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:main");
  });

  it("carries an authenticated creator's required sandbox into an outbound session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("required-outbound@example.test");
      const cfg = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" as const },
                agents: "*" as const,
                scopes: ["operator.write"],
                sandbox: "required" as const,
              },
            },
          },
        },
      };
      const context = {
        ...makeContext(),
        getRuntimeConfig: () => cfg,
      } as unknown as GatewayRequestContext;
      const client = {
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
        connect: { scopes: ["operator.write"] },
      };
      mockDeliverySuccess("required-outbound-message");

      const { respond } = await runSendWithClient(
        {
          to: "channel:first-contact",
          message: "hello",
          channel: "slack",
          idempotencyKey: "required-outbound-creation",
        },
        client,
        context,
      );

      expect(firstRespondCall(respond)[0]).toBe(true);
      expect(ensureSessionEntryCall()?.creation).toEqual({
        via: "operator",
        actor: { type: "human", source: "profile", id: profile.id },
        sandbox: "required",
      });
    });
  });

  it("uses the persisted fixed-store owner for a bare send session key", async () => {
    mockDeliverySuccess("m-persisted-owner");
    const context = fixedStoreContext();

    const { respond } = await runSendWithClient(
      {
        to: "channel:C1",
        message: "hello",
        channel: "slack",
        sessionKey: "global",
        idempotencyKey: "idem-persisted-owner",
      },
      null,
      context,
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(deliveryCall()?.session?.agentId).toBe("ops");
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

  it("rejects an explicit agentId that conflicts with the session key owner", async () => {
    mockDeliverySuccess("m-agent-precedence");

    const { respond } = await runSendWithClient(
      {
        to: "channel:C1",
        message: "hello",
        channel: "slack",
        agentId: "work",
        sessionKey: "agent:main:slack:channel:c1",
        idempotencyKey: "idem-agent-precedence",
      },
      null,
      {
        ...makeContext(),
        getRuntimeConfig: () => ({ agents: { entries: { main: {}, work: {} } } }),
      } as GatewayRequestContext,
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toBe(
      'agent "work" does not match session key agent "main"',
    );
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  registerSendSessionRoutingTests({
    mocks,
    runSend,
    mockDeliverySuccess,
    registerMessageThreadAddressingPlugin,
  });

  it("returns invalid request when outbound target resolution fails", async () => {
    mocks.resolveOutboundTarget.mockResolvedValue({
      ok: false,
      error: new Error("target not found"),
    });
    const response = await expectRejectedSend({ channel: "slack" }, "target not found");
    expect(response[3]?.channel).toBe("slack");
  });

  it("strips forged current-turn context from agent runs without an ingress capability", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      actions: {
        handleAction: vi.fn(),
      },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
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

  it("rejects a message action whose bare key conflicts with the persisted owner", async () => {
    registerMessageActionPlugin({
      id: "whatsapp",
      action: "send",
      registrySuffix: "persisted-owner-conflict",
    });
    const context = fixedStoreContext();

    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "send",
        params: { to: "alice", message: "hello" },
        sessionKey: "global",
        agentId: "research",
        idempotencyKey: "idem-message-action-owner-conflict",
      },
      agentRuntimeClient("global", "research"),
      context,
    );

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toBe(
      'agent "research" does not match session key agent "ops"',
    );
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it.each(["session mismatch", "foreign source-reply agent", "expired context"] as const)(
    "rejects ingress-issued message action authority with %s",
    async (failure) => {
      const sessionKey = "agent:main:whatsapp:direct:alice";
      const requestSessionKey =
        failure === "session mismatch" ? "agent:main:whatsapp:direct:bob" : sessionKey;
      const { respond } = await runMessageActionRequest(
        {
          channel: "whatsapp",
          action: "react",
          params: { messageId: "wamid.1", emoji: "ok" },
          sessionKey: requestSessionKey,
          sessionId: "session-1",
          agentId: "main",
          toolContext: { currentChannelProvider: "whatsapp", currentChannelId: "user:bob" },
          idempotencyKey: `invalid-context-${failure}`,
        },
        {
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey,
              messageActionContext: {
                expiresAtMs: Date.now() + (failure === "expired context" ? -1 : 60_000),
                sessionId: "session-1",
                ...(failure === "foreign source-reply agent"
                  ? { sourceReplySessionKey: "agent:other:main" }
                  : {}),
                toolContext: { currentChannelProvider: "whatsapp", currentChannelId: "user:alice" },
              },
            },
          },
        },
      );
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]?.message).toContain(
        failure === "expired context"
          ? "agent runtime context has expired"
          : "agent runtime identity does not match the requested session",
      );
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    },
  );

  it("uses the signed run session for gateway-owned source reply receipts", async () => {
    registerMessageActionPlugin({
      messageId: "tg-split-session",
      registrySuffix: "source-message-action-split-session",
    });
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-split-session" }),
    );
    const policySessionKey = "agent:main:telegram:default:direct:chat-123";
    const runSessionKey = "agent:main:main";

    const { respond } = await runTelegramTerminalAction({
      sessionId: "session-split-key",
      sessionKey: policySessionKey,
      sourceReplySessionKey: runSessionKey,
      idempotencyKey: "idem-source-message-action-split-key",
      sourceTurnId: "channel-user:v1:split-key",
      toolCallId: "message-call-split-key",
      message: "visible source reply",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-split-key",
        sessionKey: runSessionKey,
        sourceTurnId: "channel-user:v1:split-key",
        toolCallId: "message-call-split-key",
      }),
    );
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: runSessionKey }),
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: runSessionKey }),
    );
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: policySessionKey,
        deliveryRetryOwner: "caller",
        skipQueue: true,
      }),
    );
    const intent = expectDefined(
      mocks.beginRestartRecoveryTerminalDelivery.mock.invocationCallOrder[0],
      "terminal intent",
    );
    const dispatch = expectDefined(
      mocks.dispatchChannelMessageAction.mock.invocationCallOrder[0],
      "provider dispatch",
    );
    const completion = expectDefined(
      mocks.completeRestartRecoveryTerminalDelivery.mock.invocationCallOrder[0],
      "terminal completion",
    );
    expect(intent).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(completion);
  });

  it("uses a distinct transcript receipt key after progress with the same send key", async () => {
    mocks.dispatchChannelMessageAction
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-progress" }))
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-terminal" }));
    const request = {
      sessionId: "session-shared-key",
      idempotencyKey: "idem-shared-source-message-action",
      sourceTurnId: "channel-user:v1:shared-key",
      toolCallId: "message-call-shared-terminal",
    };
    const progress = await runTelegramTerminalAction({
      ...request,
      message: "progress",
      sourceReplyFinal: false,
      toolCallId: "message-call-shared-progress",
    });
    const terminal = await runTelegramTerminalAction({ ...request, message: "terminal" });
    mocks.beginRestartRecoveryTerminalDelivery.mockResolvedValueOnce("already-delivered");
    const repeatedTerminal = await runTelegramTerminalAction({
      ...request,
      message: "repeated terminal",
      idempotencyKey: "idem-repeated-terminal",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript.mock.calls).toHaveLength(2);
    expect(appendTranscriptCall(0)?.idempotencyKey).toBe("idem-shared-source-message-action");
    expect(appendTranscriptCall(1)?.idempotencyKey).toBe(
      "idem-shared-source-message-action:terminal-receipt:channel-user:v1:shared-key",
    );
    expect(firstRespondCall(progress.respond)[0]).toBe(true);
    expect(firstRespondCall(terminal.respond)[0]).toBe(true);
    expect(firstRespondCall(repeatedTerminal.respond)[0]).toBe(true);
    expect(firstRespondCall(repeatedTerminal.respond)[1]).toMatchObject({
      status: "already_delivered",
      delivered: false,
    });
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(2);
  });

  it("does not retry a delivered terminal reply when receipt finalization fails", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-ambiguous-receipt" }),
    );
    mocks.completeRestartRecoveryTerminalDelivery.mockRejectedValueOnce(
      new Error("receipt store unavailable"),
    );
    const { respond } = await runTelegramTerminalAction({
      sessionId: "session-ambiguous-receipt",
      idempotencyKey: "idem-ambiguous-receipt",
      sourceTurnId: "channel-user:v1:ambiguous-receipt",
      toolCallId: "message-call-ambiguous",
      message: "delivered with pending receipt",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
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

    const { respond } = await runTelegramTerminalAction({
      sessionId: "session-2",
      idempotencyKey: "idem-source-message-action-2",
      sourceTurnId: "channel-user:v1:telegram-message-2",
      toolCallId: "message-call-2",
      message: "delivered but unrecorded",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-2",
        sessionKey,
        sourceTurnId: "channel-user:v1:telegram-message-2",
      }),
    );
  });

  it("mirrors a Slack DM send after target resolution strips its user prefix", async () => {
    registerMessageActionPlugin({
      id: "slack",
      messageId: "slack-1",
      threading: {
        threadAddressing: "message",
        matchesToolContextTarget: ({ target, toolContext }) =>
          target.toLowerCase() ===
          toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
      },
      registrySuffix: "slack-dm-source-message-action-mirror",
    });
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
  });

  it("keeps delivered source sends successful when transcript mirroring fails", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-mirror-failed" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
      new Error("transcript unavailable"),
    );

    const { respond } = await runMessageActionRequest(
      createTelegramSourceSendRequest(
        "chat-123",
        "visible source reply",
        "idem-source-message-action-mirror-failed",
      ),
    );

    const call = firstRespondCall(respond);
    expect(call[0]).toBe(true);
    expect(call[1]).toEqual({ ok: true, messageId: "tg-mirror-failed" });
    expect(call[2]).toBeUndefined();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
  });

  it("preserves source transcript mirror order before message.action responses", async () => {
    const firstMirrorDeferred = createDeferred<SessionTranscriptAppendResult>();
    registerMessageActionPlugin({
      messageId: "tg-ordered",
      registrySuffix: "source-message-action-ordered-async-mirror",
    });
    mocks.dispatchChannelMessageAction.mockResolvedValue(
      jsonResult({ ok: true, messageId: "tg-ordered" }),
    );
    mocks.appendAssistantMessageToSessionTranscript
      .mockReturnValueOnce(firstMirrorDeferred.promise)
      .mockResolvedValueOnce({
        ok: true,
        target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
        messageId: "message-second",
      });

    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const first = invokeGatewayMessageMethod({
      method: "message.action",
      request: createTelegramSourceSendRequest(
        "chat-123",
        "first visible reply",
        "idem-ordered-source-message-action-1",
      ),
      respond: firstRespond,
      context: makeContext(),
      client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
    });
    await vi.waitFor(() => {
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    });
    const second = invokeGatewayMessageMethod({
      method: "message.action",
      request: createTelegramSourceSendRequest(
        "chat-123",
        "second visible reply",
        "idem-ordered-source-message-action-2",
      ),
      respond: secondRespond,
      context: makeContext(),
      requestId: "2",
      client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(firstRespond).not.toHaveBeenCalled();
    expect(secondRespond).not.toHaveBeenCalled();
    expect(appendTranscriptCall(0)).toEqual(
      expect.objectContaining({ text: "first visible reply" }),
    );

    firstMirrorDeferred.resolve({
      ok: true,
      target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
      messageId: "message-first",
    });
    await first;
    await second;

    expect(firstRespondCall(firstRespond)[0]).toBe(true);
    expect(firstRespondCall(secondRespond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(appendTranscriptCall(1)).toEqual(
      expect.objectContaining({ text: "second visible reply" }),
    );
  });

  it("leaves terminal delivery pending when dispatch throws with an unknown outcome", async () => {
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(new Error("provider timeout"));
    const { respond } = await runTelegramTerminalAction({
      sessionId: "session-timeout",
      idempotencyKey: "idem-timeout-message-action",
      sourceTurnId: "channel-user:v1:timeout",
      toolCallId: "message-call-timeout",
      message: "maybe delivered",
    });

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]).toMatchObject({ code: ErrorCodes.UNAVAILABLE });
    expect(firstRespondCall(respond)[2]?.retryable).toBeUndefined();
    expect(firstRespondCall(respond)[2]?.details).toBeUndefined();
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.completeRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
  });

  it("returns the caption receipt through message.action when dispatch fails with partial delivery", async () => {
    // A caption sent before the media upload failed carries a partial-delivery
    // receipt. The Gateway boundary must surface that receipt on the structured
    // error and mark the result non-retryable, so the agent does not resend an
    // already-visible caption.
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("upload failed"), {
        messageIds: ["caption_msg"],
        visibleReplySent: true,
      }),
    );
    const { respond } = await runTelegramTerminalAction({
      sessionId: "session-partial",
      idempotencyKey: "idem-partial-delivery",
      sourceTurnId: "channel-user:v1:partial",
      toolCallId: "message-call-partial",
      message: "caption text",
    });

    const response = firstRespondCall(respond);
    expect(response[0]).toBe(false);
    expect(response[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(response[2]?.retryable).toBe(false);
    expect(response[2]?.details).toMatchObject({
      partialDelivery: {
        messageIds: ["caption_msg"],
        visibleReplySent: true,
      },
    });
    expect(JSON.stringify(response[2])).toContain("caption_msg");
    expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  describe("canonical outbound send", () => {
    let plugin: ChannelPlugin;

    beforeEach(() => {
      plugin = {
        ...createChannelTestPluginBase({
          id: "twitch",
          capabilities: { chatTypes: ["group"] },
          config: {
            listAccountIds: () => ["default", "secondary"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
            resolveDefaultTo: ({ accountId }) => `${accountId ?? "default"}-room`,
          },
        }),
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          messageActionTargetAliases: {
            send: { aliases: ["roomId"], deliveryTargetAliases: ["roomId"] },
          },
        },
        messaging: {
          targetResolver: { looksLikeId: () => true, hint: "<room>" },
        },
        outbound: {
          deliveryMode: "direct",
          sendText: async () => ({ channel: "twitch", messageId: "core-send" }),
        },
      };
      mocks.getChannelPlugin.mockReturnValue(plugin);
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "twitch", source: "test", plugin }]),
        `send-test-canonical-${registrySeq}`,
      );
      mocks.resolveMessageChannelSelection.mockResolvedValue({ channel: "twitch", plugin });
      mocks.resolveOutboundTarget.mockImplementation(async (target) =>
        expectDefined(
          await resolveOutboundTargetWithPlugin({ plugin, target }),
          "registered plugin resolves outbound targets",
        ),
      );
      mocks.dispatchChannelMessageAction.mockResolvedValue(null);
      mocks.deliverOutboundPayloads.mockResolvedValue([
        { channel: "twitch", messageId: "core-send" },
      ]);
    });

    it("routes the account default through one canonical gateway send", async () => {
      plugin.outbound!.deliveryMode = "gateway";
      const { respond } = await runMessageActionRequest(
        {
          channel: "twitch",
          action: "send",
          params: { message: "hello" },
          accountId: "secondary",
          idempotencyKey: "canonical-send-default",
        },
        directCliClient(),
      );
      const response = firstRespondCall(respond);
      expect(response[2]).toBeUndefined();
      expect(response[0]).toBe(true);
      expect(response[1]).toMatchObject({
        channel: "twitch",
        to: "secondary-room",
        via: "gateway",
        deliveryStatus: "sent",
        result: { messageId: "core-send" },
      });
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(deliveryCall()).toMatchObject({
        to: "secondary-room",
        accountId: "secondary",
        payloads: [expect.objectContaining({ text: "hello" })],
      });
      expect(lastDispatchChannelMessageActionCall()?.deliveryRetryOwner).toBeUndefined();
      expect(lastDispatchChannelMessageActionCall()?.skipQueue).toBe(false);
      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    });

    it("rejects a channel without canonical outbound send capability", async () => {
      plugin.outbound = undefined;
      const { respond } = await runMessageActionRequest({
        channel: "twitch",
        action: "send",
        params: { to: "explicit-room", message: "hello" },
        idempotencyKey: "canonical-send-unsupported",
      });

      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(firstRespondCall(respond)[2]).toMatchObject({
        code: ErrorCodes.INVALID_REQUEST,
        message: "Channel twitch does not support action send.",
      });
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    });

    it("scopes reused idempotency keys to each message action", async () => {
      plugin.actions = {
        describeMessageTool: () => ({ actions: ["react"] }),
        supportsAction: ({ action }) => action === "react",
        handleAction: async () => jsonResult({ ok: true }),
      };
      plugin.outbound!.sendPoll = mocks.sendPoll;
      mocks.dispatchChannelMessageAction.mockImplementation(async ({ action }) =>
        action === "react" ? jsonResult({ ok: true, action }) : null,
      );
      const context = makeContext();
      const idempotencyKey = "shared-action-idempotency";
      const request = (action: string, params: Record<string, unknown>) =>
        runMessageActionRequest(
          { channel: "twitch", action, params, idempotencyKey },
          directCliClient(),
          context,
        );

      const send = await request("send", { to: "same-room", message: "hello" });
      const poll = await request("poll", {
        to: "same-room",
        pollQuestion: "Ship it?",
        pollOption: ["Yes", "No"],
      });
      const react = await request("react", {
        to: "same-room",
        messageId: "m-1",
        emoji: "ok",
      });

      expect(firstRespondCall(send.respond)[1]).toMatchObject({ deliveryStatus: "sent" });
      expect(firstRespondCall(poll.respond)[1]).toMatchObject({ question: "Ship it?" });
      expect(firstRespondCall(react.respond)[1]).toEqual({ ok: true, action: "react" });
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(mocks.sendPoll).toHaveBeenCalledOnce();
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(3);
    });

    it.each(["dispatch", "handoff"])(
      "fences canonical outbound send at %s when runtime authority closes",
      async (boundary) => {
        let authorityActive = true;
        const platformSend = vi.fn();
        mocks.deliverOutboundPayloads.mockImplementationOnce(
          async (params: {
            onPlatformSendDispatch?: () => Promise<void>;
            assertDirectAdapterHandoff?: () => void;
          }) => {
            authorityActive = boundary !== "dispatch";
            await params.onPlatformSendDispatch?.();
            authorityActive = false;
            params.assertDirectAdapterHandoff?.();
            platformSend();
            return [{ channel: "twitch", messageId: "must-not-send" }];
          },
        );
        const sessionKey = "agent:main:twitch:group:explicit-room";
        const { respond } = await runMessageActionRequest(
          {
            channel: "twitch",
            action: "send",
            params: { to: "explicit-room", message: "must not escape" },
            sessionKey,
            idempotencyKey: "canonical-send-authority-race",
          },
          agentRuntimeClient(sessionKey),
          {
            ...makeContext(),
            validateAgentRuntimeApprovalAuthority: () => authorityActive,
          } as GatewayRequestContext,
        );

        expect(firstRespondCall(respond)[0]).toBe(false);
        expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
        expect(deliveryCall()?.skipQueue).toBe(true);
        expect(platformSend).not.toHaveBeenCalled();
        expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      },
    );
  });

  it("uses signed sender group policy without granting gateway send host reads", async () => {
    const plugin = registerMessageActionPlugin({
      chatType: "group",
      registrySuffix: "message-action-signed-sender-media-policy",
    });
    const resolveToolPolicy = vi.fn(({ senderId }: { senderId?: string | null }) =>
      senderId === "blocked-sender" ? { deny: ["read"] } : undefined,
    );
    plugin.groups = { resolveToolPolicy };
    const sessionKey = "agent:work:telegram:group:ops";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: { to: "ops", message: "chart", mediaUrl: "chart.png" },
        requesterSenderId: "forged-allowed-sender",
        sessionKey,
        agentId: "work",
        idempotencyKey: "idem-message-action-signed-sender-media-policy",
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "work",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              requesterSenderId: "blocked-sender",
            },
          },
        },
      },
      {
        ...makeContext(),
        getRuntimeConfig: () => ({
          agents: { entries: { main: {}, work: {} } },
          tools: { allow: ["read"] },
        }),
      } as GatewayRequestContext,
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(resolveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "ops", senderId: "blocked-sender" }),
    );
    const actionCall = lastDispatchChannelMessageActionCall();
    expect(actionCall?.requesterSenderId).toBe("blocked-sender");
    expect(actionCall?.mediaAccess.workspaceDir).toBe(TEST_AGENT_WORKSPACE);
    expect(actionCall?.mediaAccess).not.toHaveProperty("readFile");
    expect(actionCall).not.toHaveProperty("mediaReadFile");
  });

  it("applies signed sender aliases to gateway send media policy", async () => {
    const action = "send";
    const params = { to: "123", message: "chart" };
    registerMessageActionPlugin({
      action,
      registrySuffix: `message-action-signed-sender-alias-policy-${action}`,
    });
    const sessionKey = "agent:work:telegram:direct:123";

    await withTempOpenClawStateDir(async (stateDir) => {
      const workspaceFile = path.join(
        TEST_AGENT_WORKSPACE,
        `gateway-alias-denied-${process.pid}.bin`,
      );
      const managedFile = path.join(stateDir, "media", "outbound", "managed.bin");
      await fs.mkdir(TEST_AGENT_WORKSPACE, { recursive: true });
      await fs.mkdir(path.dirname(managedFile), { recursive: true });
      await fs.writeFile(workspaceFile, "private");
      await fs.writeFile(managedFile, "managed");

      try {
        const { respond } = await runMessageActionRequest(
          {
            channel: "telegram",
            action,
            params: { ...params, mediaUrl: workspaceFile },
            requesterSenderId: "forged-allowed-sender",
            sessionKey,
            agentId: "work",
            idempotencyKey: `idem-message-action-signed-sender-alias-policy-${action}`,
          },
          {
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "work",
                sessionKey,
                messageActionContext: {
                  expiresAtMs: Date.now() + 60_000,
                  requesterSenderId: "allowed-id",
                  requesterSenderName: "Blocked Sender",
                  requesterSenderUsername: "blocked-user",
                  requesterSenderE164: "+15551234567",
                },
              },
            },
          },
          {
            ...makeContext(),
            getRuntimeConfig: () => ({
              agents: { entries: { main: {}, work: {} } },
              tools: {
                allow: ["read"],
                toolsBySender: { "username:blocked-user": { deny: ["read"] } },
              },
            }),
          } as GatewayRequestContext,
        );

        expect(firstRespondCall(respond)[0]).toBe(true);
        const actionCall = lastDispatchChannelMessageActionCall();
        expect(actionCall).toMatchObject({
          requesterSenderId: "allowed-id",
          requesterSenderName: "Blocked Sender",
          requesterSenderUsername: "blocked-user",
          requesterSenderE164: "+15551234567",
        });
        expect(actionCall?.params).toMatchObject({ mediaUrl: workspaceFile });
        expect(actionCall?.params).not.toHaveProperty("buffer");
        const mediaAccess = actionCall?.mediaAccess;
        expect(mediaAccess.localRoots).not.toContain(TEST_AGENT_WORKSPACE);
        await expect(
          loadWebMediaRaw(workspaceFile, buildOutboundMediaLoadOptions({ mediaAccess })),
        ).rejects.toThrow(/not under an allowed directory/i);
        const managed = await loadWebMediaRaw(
          managedFile,
          buildOutboundMediaLoadOptions({ mediaAccess }),
        );
        expect(managed.buffer.toString()).toBe("managed");
      } finally {
        await fs.rm(workspaceFile, { force: true });
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
