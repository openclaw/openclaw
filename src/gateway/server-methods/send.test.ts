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
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { resolveOutboundTargetWithPlugin } from "../../infra/outbound/targets-resolve-shared.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
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
  messageActionClientForTests,
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

function transcriptResult(messageId: string): SessionTranscriptAppendResult {
  return {
    ok: true,
    target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
    messageId,
  };
}

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn<() => Promise<SessionTranscriptAppendResult>>(
    async () => transcriptResult("message-x"),
  ),
  beginRestartRecoveryTerminalDelivery: vi.fn<
    () => Promise<
      "started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"
    >
  >(async () => "started"),
  cancelRestartRecoveryTerminalDelivery: vi.fn(async () => "cleared" as const),
  completeRestartRecoveryTerminalDelivery: vi.fn(async () => "recorded" as const),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn<ResolveOutboundTarget>(),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  dispatchChannelMessageAction: vi.fn(),
  sendPoll: vi.fn<NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>>(),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  getRuntimeConfigSnapshot: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  loadSessionEntry:
    vi.fn<
      (sessionKey: string) => { canonicalKey: string; entry: { sessionId: string } | undefined }
    >(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));

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

vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigSnapshot: mocks.getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
}));

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

vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
}));

vi.mock("../../config/sessions/restart-recovery-receipt.js", () => ({
  beginRestartRecoveryTerminalDelivery: mocks.beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery: mocks.cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery: mocks.completeRestartRecoveryTerminalDelivery,
}));

// mock-isolation: Send-method fixtures bind synthetic session rows without opening session storage.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string }) =>
    mocks.loadSessionEntry(params.key),
}));

const {
  invokeGatewayMessageMethod,
  runSendWithClient: sendWithClient,
  runPoll,
  runMessageActionRequest: actionWithClient,
  runTelegramTerminalAction: terminalAction,
} = createMessageMethodTestDriver(() => sendHandlers);

const terminalRequest = {
  sessionId: "session-terminal",
  idempotencyKey: "idem-terminal",
  sourceTurnId: "channel-user:v1:terminal",
  toolCallId: "tool-terminal",
  message: "terminal reply",
};
const runTelegramTerminalAction = (params: Partial<Parameters<typeof terminalAction>[0]> = {}) =>
  terminalAction({ ...terminalRequest, ...params });

function runSendWithClient(...[params, ...args]: Parameters<typeof sendWithClient>) {
  return sendWithClient(
    {
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      idempotencyKey: "send-test",
      ...params,
    },
    ...args,
  );
}
const runSend = runSendWithClient;

function runMessageActionRequest(...[params, ...args]: Parameters<typeof actionWithClient>) {
  return actionWithClient(
    { channel: "slack", action: "send", idempotencyKey: "action-test", ...params },
    ...args,
  );
}

function startRequest(
  request: Record<string, unknown>,
  options: Partial<
    Omit<Parameters<typeof invokeGatewayMessageMethod>[0], "request" | "respond">
  > = {},
) {
  const respond = vi.fn();
  const promise = invokeGatewayMessageMethod({
    method: "message.action",
    ...options,
    context: options.context ?? makeContext(),
    request,
    respond,
  });
  return { respond, promise };
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

function mockArgument(calls: unknown[][], index = 0): Record<string, any> | undefined {
  return calls.at(index)?.[0] as ReturnType<typeof mockArgument>;
}
const deliveryCall = (index = 0) => mockArgument(mocks.deliverOutboundPayloads.mock.calls, index);
const appendTranscriptCall = (index = 0) =>
  mockArgument(mocks.appendAssistantMessageToSessionTranscript.mock.calls, index);
const lastDispatchChannelMessageActionCall = () =>
  mockArgument(mocks.dispatchChannelMessageAction.mock.calls, -1);
const ensureSessionEntryCall = (index = 0) =>
  mockArgument(mocks.ensureOutboundSessionEntry.mock.calls, index);

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

const { registerMessageThreadAddressingPlugin, registerMessageActionPlugin } =
  createMessageMethodPluginFixtures(mocks);

async function expectRejectedSend(params: Record<string, unknown>, message: string) {
  const { respond } = await runSend({ message: "hi", ...params });
  const response = firstRespondCall(respond);
  expect(response[0]).toBe(false);
  expect(response[1]).toBeUndefined();
  expect(response[2]?.message).toContain(message);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return response;
}

function fixedStoreContext(): GatewayRequestContext {
  return makeContext(() => ({
    session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    },
  }));
}

function routePlugin(channel: string, config: Partial<ChannelPlugin["config"]> = {}) {
  return {
    id: channel,
    actions: { handleAction: true },
    outbound: { sendPoll: mocks.sendPoll },
    config: {
      listAccountIds: (cfg: { channels?: Record<string, { accounts?: object }> }) => {
        const ids = Object.keys(cfg.channels?.[channel]?.accounts ?? {});
        return ids.length ? ids : ["default"];
      },
      resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId, enabled: true }),
      ...config,
    },
  };
}

function mockMutableMessageRouteAccounts(resolveDefaultAccountId: (channel: string) => string) {
  mocks.getChannelPlugin.mockImplementation((channel: string) =>
    routePlugin(channel, {
      listAccountIds: () => ["primary", "secondary"],
      defaultAccountId: () => resolveDefaultAccountId(channel),
    }),
  );
}

function startDedupeMaintenance(context: GatewayRequestContext) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
  return startGatewayMaintenanceTimers({
    ...createGatewayMaintenanceStateForTest(),
    dedupe: context.dedupe,
  });
}

function dedupeRouteFixture() {
  let defaultAccountId = "primary";
  mockMutableMessageRouteAccounts(() => defaultAccountId);
  const context = makeContext(),
    maintenance = startDedupeMaintenance(context);
  return {
    context,
    invoke: (idempotencyKey: string) =>
      startRequest(
        {
          channel: "slack",
          action: "send",
          params: { target: "channel:current", message: "hi" },
          idempotencyKey,
        },
        { context },
      ),
    changeDefault: () => {
      defaultAccountId = "secondary";
    },
    close: async () => {
      await maintenance.stopPeriodicTasks();
      await maintenance.skillUsageCleanup();
      vi.useRealTimers();
    },
  };
}

function expectAuthorityDenied(respond: ReturnType<typeof vi.fn>) {
  expect(firstRespondCall(respond)[0]).toBe(false);
  expect(firstRespondCall(respond)[2]?.message).toContain("authority is no longer active");
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  const response = firstRespondCall(respond);
  expect(response[0]).toBe(false);
  expect(response[2]).toMatchObject(error);
  return response;
}

function expectCall(mock: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

const waitForCalls = (mock: ReturnType<typeof vi.fn>, count = 1) =>
  vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));

function expectSuccess(respond: ReturnType<typeof vi.fn>, payload?: unknown, channel?: string) {
  const response = firstRespondCall(respond);
  expect(response[0]).toBe(true);
  expect(response[2]).toBeUndefined();
  if (payload !== undefined) {
    expect(response[1]).toEqual(payload);
  }
  if (channel !== undefined) {
    expect(response[3]?.channel).toBe(channel);
  }
  return response;
}

type DeliveryGuards = {
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
};
function holdDelivery(boundary: "dispatch" | "handoff" | "read") {
  const entered = createDeferred(),
    release = createDeferred(),
    platformSend = vi.fn();
  const provider =
    boundary === "read" ? mocks.dispatchChannelMessageAction : mocks.deliverOutboundPayloads;
  provider.mockImplementationOnce(async (params: DeliveryGuards) => {
    if (boundary === "handoff") {
      await params.onPlatformSendDispatch?.();
    }
    entered.resolve();
    await release.promise;
    if (boundary === "dispatch") {
      await params.onPlatformSendDispatch?.();
    } else {
      params.assertDirectAdapterHandoff?.();
    }
    platformSend();
    return boundary === "read"
      ? { details: { ok: true } }
      : [{ channel: "slack", messageId: "must-not-send" }];
  });
  return { entered, release, platformSend };
}

function liveAuthority(getRuntimeConfig?: GatewayRequestContext["getRuntimeConfig"]) {
  let active = true;
  return {
    context: {
      ...makeContext(getRuntimeConfig),
      validateAgentRuntimeApprovalAuthority: () => active,
    },
    revoke: () => {
      active = false;
    },
  };
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
    mocks.getChannelPlugin.mockImplementation((channel: string) => routePlugin(channel));
  });

  it.each([
    ["missing", "Unknown account"],
    ["sut", "does not match"],
  ] as const)(
    "rejects message.action account %s before provider code",
    async (accountId, expectedError) => {
      const resolveAccountAsync = vi.fn(
        async (_cfg: unknown, resolvedAccountId?: string | null) => ({
          enabled: resolvedAccountId !== "disabled",
        }),
      );
      mocks.getChannelPlugin.mockReturnValue(
        routePlugin("slack", {
          listAccountIds: () => ["default", "sut", "disabled"],
          resolveAccountAsync,
          resolveAccount: (_cfg: unknown, resolvedAccountId?: string | null) => ({
            enabled: resolvedAccountId !== "disabled",
          }),
        }),
      );

      const { respond } = await runMessageActionRequest({
        accountId,
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
      },
      null,
      makeContext(() => sourceConfig),
    );
    expect(mocks.getRuntimeConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getRuntimeConfigSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(lastDispatchChannelMessageActionCall()?.cfg).toBe(runtimeConfig);
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("does not share message.action idempotency results across authority origins", async () => {
    const context = makeContext();
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
    const sessionKey = "agent:main:slack:channel:C1";

    const direct = startRequest(
      { ...params, conversationReadOrigin: "direct-operator" },
      {
        context,
        requestId: "direct",
      },
    );
    const delegated = startRequest(
      { ...params, sessionKey, agentId: "main", conversationReadOrigin: "direct-operator" },
      {
        context,
        requestId: "delegated",
        client: { ...directCliClient(), ...messageActionClientForTests(sessionKey) } as never,
      },
    );

    await waitForCalls(mocks.dispatchChannelMessageAction, 2);
    expect(mocks.dispatchChannelMessageAction.mock.calls[0]?.[0]).toMatchObject({
      conversationReadOrigin: "direct-operator",
    });
    expect(mocks.dispatchChannelMessageAction.mock.calls[1]?.[0]).toMatchObject({
      conversationReadOrigin: "delegated",
    });

    firstDeferred.resolve({ details: { action: "direct" } });
    secondDeferred.resolve({ details: { action: "delegated" } });
    await Promise.all([direct.promise, delegated.promise]);
    expect(firstRespondCall(direct.respond)?.[1]).toEqual({ action: "direct" });
    expect(firstRespondCall(delegated.respond)?.[1]).toEqual({ action: "delegated" });
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("dedupes omitted and explicit default message.action accounts", async () => {
    const context = makeContext();
    const actionDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockReturnValueOnce(actionDeferred.promise);

    const request = {
      channel: "slack",
      action: "send",
      params: { target: "channel:current", message: "hi" },
      idempotencyKey: "idem-action-effective-default",
    };
    const omitted = startRequest(request, { context, requestId: "omitted" });
    const explicit = startRequest(
      { ...request, accountId: "default" },
      { context, requestId: "explicit" },
    );

    await waitForCalls(mocks.dispatchChannelMessageAction);
    actionDeferred.resolve({ details: { action: "handled" } });
    await Promise.all([omitted.promise, explicit.promise]);

    for (const [index, { respond }] of [omitted, explicit].entries()) {
      expect(respond).toHaveBeenCalledOnce();
      const response = firstRespondCall(respond);
      expect(response.slice(0, 3)).toEqual([true, { action: "handled" }, undefined]);
      expect(response[3]?.channel).toBe("slack");
      expect(response[3]?.cached).toBe(index === 0 ? undefined : true);
    }
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending message.action route bound through maintenance and default changes", async () => {
    const fixture = dedupeRouteFixture();
    const { context } = fixture;
    const actionDeferred = createDeferred<{ details: { action: string } }>();
    mocks.dispatchChannelMessageAction.mockReturnValueOnce(actionDeferred.promise);
    try {
      const first = fixture.invoke("idem-action-pending-maintenance");
      await waitForCalls(mocks.dispatchChannelMessageAction);
      expect([...context.dedupe.keys()].some((key) => key.includes(":route-binding:"))).toBe(false);

      await vi.advanceTimersByTimeAsync(DEDUPE_TTL_MS + 60_000);
      fixture.changeDefault();
      const retry = fixture.invoke("idem-action-pending-maintenance");
      await waitForCalls(mocks.dispatchChannelMessageAction);

      actionDeferred.resolve({ details: { action: "handled" } });
      await Promise.all([first.promise, retry.promise]);

      expect(firstRespondCall(first.respond)?.[0]).toBe(true);
      expect(firstRespondCall(retry.respond)?.[0]).toBe(true);
      expect(firstRespondCall(retry.respond)?.[3]?.cached).toBe(true);
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it("does not let settled route aliases evict canonical results before ttl", async () => {
    const fixture = dedupeRouteFixture();
    const { context } = fixture;
    const operationCount = Math.floor(DEDUPE_MAX / 2) + 1;

    try {
      for (let index = 0; index < operationCount; index += 1) {
        await fixture.invoke(`idem-action-capacity-${index}`).promise;
      }

      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(operationCount);
      expect(context.dedupe.size).toBe(operationCount);
      expect([...context.dedupe.keys()].some((key) => key.includes(":route-binding:"))).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      fixture.changeDefault();
      const retry = fixture.invoke("idem-action-capacity-0");
      await retry.promise;

      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(operationCount);
      expect(firstRespondCall(retry.respond)?.[0]).toBe(true);
      expect(firstRespondCall(retry.respond)?.[3]?.cached).toBe(true);
    } finally {
      await fixture.close();
    }
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
        params: { channelId: "C1", message: "hi" },
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
          message: "must not escape",
          sessionKey: "agent:main:slack:channel:C1",
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
      await waitForCalls(mocks.resolveOutboundSessionRoute);
      authorityActive = false;
      preparation.resolve(null);

      const { respond } = await request;
      expectAuthorityDenied(respond);
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
    const plugin = registerMessageActionPlugin({});
    plugin.actions = telegramMessageActions;
    mocks.dispatchChannelMessageAction.mockImplementationOnce(dispatchChannelMessageAction);
    const firstSendStarted = createDeferred();
    const releaseFirstSend = createDeferred();
    const physicalSends: string[] = [];
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryGuards) => {
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
    });
    const authority = liveAuthority(() => ({
      channels: { telegram: { botToken: "123456:fixture" } },
    }));
    const sessionKey = "agent:main:telegram:direct:12345";
    const request = runMessageActionRequest(
      {
        channel: "telegram",
        params: {
          to: "12345",
          message: "photos",
          mediaUrls: ["https://example.com/one.jpg", "https://example.com/two.jpg"],
        },
        sessionKey,
      },
      agentRuntimeClient(sessionKey),
      authority.context,
    );
    await firstSendStarted.promise;
    authority.revoke();
    releaseFirstSend.resolve();
    const { respond } = await request;

    expect(physicalSends).toEqual(["album"]);
    expect(deliveryCall()?.skipQueue).toBe(true);
    expectAuthorityDenied(respond);
  });

  it.each(["dispatch", "handoff"] as const)(
    "does not send or queue after delegated authority closes during delivery preflight (%s)",
    async (boundary) => {
      const delivery = holdDelivery(boundary);
      const authority = liveAuthority();
      const request = runSendWithClient(
        {
          message: "must not escape",
          sessionKey: "agent:main:slack:channel:C1",
        },
        agentRuntimeClient("agent:main:slack:channel:C1"),
        authority.context,
      );
      await delivery.entered.promise;
      authority.revoke();
      delivery.release.resolve();

      const { respond } = await request;
      expectAuthorityDenied(respond);
      expect(deliveryCall()?.skipQueue).toBe(true);
      expect(delivery.platformSend).not.toHaveBeenCalled();
    },
  );

  it.each(["read", "send"] as const)(
    "fences delegated %s when its turn closes during provider work",
    async (action) => {
      const delivery = holdDelivery(action === "read" ? "read" : "dispatch");
      const sessionKey = "agent:main:slack:channel:C1";
      const owned = createMessageActionTurnClientForTests({
        sessionKey,
        runId: `${action}-turn-revocation`,
      });
      try {
        const request =
          action === "read"
            ? runMessageActionRequest(
                { action, params: { channelId: "C2", limit: 1 }, sessionKey },
                owned.client,
                owned.context,
              )
            : runSendWithClient(
                { message: "must not escape", sessionKey },
                owned.client,
                owned.context,
              );
        await delivery.entered.promise;
        expect(revokeMessageActionTurnCapability(owned.turnCapability)).toBe(true);
        delivery.release.resolve();
        expectAuthorityDenied((await request).respond);
        expect(delivery.platformSend).not.toHaveBeenCalled();
      } finally {
        delivery.release.resolve();
        owned.close();
      }
    },
  );

  registerSendDeliveryAttemptTests({ mocks, invokeGatewayMessageMethod, mockDeliverySuccess });

  it("cancels a prepared terminal receipt when authority closes before action dispatch", async () => {
    const receipt = createDeferred<"started">();
    mocks.beginRestartRecoveryTerminalDelivery.mockReturnValueOnce(receipt.promise);
    const authority = liveAuthority();
    const request = runTelegramTerminalAction({
      message: "must not escape",
      context: authority.context,
    });
    await waitForCalls(mocks.beginRestartRecoveryTerminalDelivery);
    authority.revoke();
    receipt.resolve("started");

    const { respond } = await request;
    expectAuthorityDenied(respond);
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
    const first = startRequest(request, { method: "send", context });
    await waitForCalls(mocks.resolveMessageChannelSelection);

    const retry = startRequest(request, { method: "send", context });
    await Promise.resolve();
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledTimes(1);

    firstSelection.resolve({ channel: "slack", configured: ["slack"] });
    await waitForCalls(mocks.deliverOutboundPayloads);
    providerDeferred.resolve([{ messageId: "m-race", channel: "slack" }]);
    await Promise.all([first.promise, retry.promise]);

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(first.respond)?.[0]).toBe(true);
    expect(firstRespondCall(retry.respond)?.[0]).toBe(true);
    expect(firstRespondCall(retry.respond)?.[3]?.cached).toBe(true);
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
    });

    expect(deliveryCall()).toMatchObject({
      channel: "whatsapp",
      replyToId: "media-parent",
      mirror: { text: " \tcaption" },
      session: { agentId: "work", key: "agent:work:whatsapp:resolved" },
    });
    expect(deliveryCall()?.payloads).toEqual([
      {
        text: " \tcaption  \n\n",
        mediaUrl: "file:///tmp/workspace/photo.png",
        mediaUrls: undefined,
      },
    ]);
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
    const { respond } = await sendWithClient(
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
      message: "voice note",
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      asVoice: true,
    });

    expect(deliveryCall()?.payloads?.[0]).toMatchObject({
      text: "voice note",
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      audioAsVoice: true,
    });
    expectSuccess(respond, expect.objectContaining({ messageId: "m-voice" }), "slack");
  });

  it.each([
    ["slack", "   ", "text or media is required"],
    ["webchat", "hi", "unsupported channel: webchat"],
    [
      "definitely-not-a-real-channel-xyz",
      "hi",
      "unsupported channel: definitely-not-a-real-channel-xyz",
    ],
    ["slack", "hi", "target not found"],
  ])("rejects channel %s and message %j: %s", async (channel, message, error) => {
    if (channel === "definitely-not-a-real-channel-xyz") {
      mocks.getChannelPlugin.mockReturnValue(undefined);
    }
    if (error === "target not found") {
      mocks.resolveOutboundTarget.mockResolvedValue({ ok: false, error: new Error(error) });
    }
    const response = await expectRejectedSend({ channel, message }, error);
    if (channel === "webchat") {
      expect(response[2]?.message).toContain("Use `chat.send`");
    }
    if (error === "target not found") {
      expect(response[3]?.channel).toBe("slack");
    }
  });

  it("includes optional poll delivery identifiers in the gateway payload", async () => {
    const result = {
      messageId: "poll-rich",
      channelId: "C123",
      conversationId: "conv-1",
      toJid: "jid-1",
      pollId: "poll-meta-1",
    };
    mocks.sendPoll.mockResolvedValue(result);

    const { respond } = await runPoll({
      to: "channel:C1",
      question: "Q?",
      options: ["A", "B"],
      channel: "slack",
      idempotencyKey: "idem-poll-rich",
    });

    expectSuccess(respond, { ...result, runId: "idem-poll-rich", channel: "slack" }, "slack");
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
      message: "hi",
      sessionKey: "agent:main:main",
    });

    expectFailure(respond, { code: ErrorCodes.UNAVAILABLE });
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:main");
  });

  it("carries an authenticated creator's required sandbox into an outbound session", async () =>
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("required-outbound@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
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
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg);
      const context = makeContext(() => cfg);
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
    }));

  it("uses the persisted fixed-store owner for a bare send session key", async () => {
    mockDeliverySuccess("m-persisted-owner");
    const context = fixedStoreContext();

    const { respond } = await runSendWithClient({ sessionKey: "global" }, null, context);

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(deliveryCall()?.session?.agentId).toBe("ops");
  });

  it("rejects a missing reserved agent-harness session before persistence or delivery", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing";

    const { respond } = await runSend({
      sessionKey,
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
      sessionKey: "agent:work:slack:channel:c1",
    });

    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(deliveryCall()).toMatchObject({
      session: { agentId: "work", key: "agent:work:slack:channel:c1" },
      mirror: { agentId: "work", sessionKey: "agent:work:slack:channel:c1" },
    });
  });

  it("rejects an explicit agentId that conflicts with the session key owner", async () => {
    mockDeliverySuccess("m-agent-precedence");

    const { respond } = await runSendWithClient(
      {
        agentId: "work",
        sessionKey: "agent:main:slack:channel:c1",
      },
      null,
      makeContext(() => ({ agents: { entries: { main: {}, work: {} } } })),
    );

    expectFailure(respond, { message: 'agent "work" does not match session key agent "main"' });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  registerSendSessionRoutingTests({
    mocks,
    runSend,
    mockDeliverySuccess,
    registerMessageThreadAddressingPlugin,
  });

  it("rejects a message action whose bare key conflicts with the persisted owner", async () => {
    registerMessageActionPlugin({
      id: "whatsapp",
      action: "send",
    });
    const context = fixedStoreContext();

    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        params: { to: "alice", message: "hello" },
        sessionKey: "global",
        agentId: "research",
      },
      agentRuntimeClient("global", "research"),
      context,
    );

    expectFailure(respond, { message: 'agent "research" does not match session key agent "ops"' });
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
  });

  it.each([
    "missing context",
    "session mismatch",
    "foreign source-reply agent",
    "expired context",
  ] as const)("validates ingress-issued message action authority: %s", async (failure) => {
    const missing = failure === "missing context";
    if (missing) {
      mocks.getChannelPlugin.mockReturnValue({
        id: "whatsapp",
        actions: { handleAction: vi.fn() },
        config: { listAccountIds: () => ["default"], resolveAccount: () => ({ enabled: true }) },
      });
      mocks.dispatchChannelMessageAction.mockResolvedValueOnce(jsonResult({ ok: true }));
    }
    const sessionKey = "agent:main:whatsapp:direct:alice";
    const { respond } = await runMessageActionRequest(
      {
        channel: "whatsapp",
        action: "react",
        params: { messageId: "wamid.1", emoji: "ok" },
        requesterAccountId: "default",
        requesterSenderId: "forged-sender",
        sessionKey: failure === "session mismatch" ? "agent:main:whatsapp:direct:bob" : sessionKey,
        sessionId: "session-1",
        agentId: "main",
        toolContext: { currentChannelProvider: "whatsapp", currentChannelId: "user:bob" },
        idempotencyKey: `invalid-context-${failure}`,
      },
      messageActionClientForTests(sessionKey, {
        messageActionContext: missing
          ? undefined
          : {
              expiresAtMs: Date.now() + (failure === "expired context" ? -1 : 60_000),
              sessionId: "session-1",
              ...(failure === "foreign source-reply agent"
                ? { sourceReplySessionKey: "agent:other:main" }
                : {}),
              toolContext: { currentChannelProvider: "whatsapp", currentChannelId: "user:alice" },
            },
      }),
    );
    expect(firstRespondCall(respond)[0]).toBe(missing);
    if (missing) {
      expectCall(mocks.dispatchChannelMessageAction, {
        requesterAccountId: undefined,
        requesterSenderId: undefined,
        toolContext: undefined,
      });
    } else {
      expect(firstRespondCall(respond)[2]?.message).toContain(
        failure === "expired context"
          ? "agent runtime context has expired"
          : "agent runtime identity does not match the requested session",
      );
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    }
  });

  it("uses the signed run session for gateway-owned source reply receipts", async () => {
    registerMessageActionPlugin();
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-split-session" }),
    );
    const policySessionKey = "agent:main:telegram:default:direct:chat-123";
    const runSessionKey = "agent:main:main";

    const { respond } = await runTelegramTerminalAction({
      sessionKey: policySessionKey,
      sourceReplySessionKey: runSessionKey,
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expectCall(mocks.beginRestartRecoveryTerminalDelivery, {
      sessionId: terminalRequest.sessionId,
      sessionKey: runSessionKey,
      sourceTurnId: terminalRequest.sourceTurnId,
      toolCallId: terminalRequest.toolCallId,
    });
    expectCall(mocks.completeRestartRecoveryTerminalDelivery, { sessionKey: runSessionKey });
    expectCall(mocks.appendAssistantMessageToSessionTranscript, { sessionKey: runSessionKey });
    expectCall(mocks.dispatchChannelMessageAction, {
      sessionKey: policySessionKey,
      deliveryRetryOwner: "caller",
      skipQueue: true,
    });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      expectDefined(mock.mock.invocationCallOrder[0], "delivery call order");
    expect(order(mocks.beginRestartRecoveryTerminalDelivery)).toBeLessThan(
      order(mocks.dispatchChannelMessageAction),
    );
    expect(order(mocks.dispatchChannelMessageAction)).toBeLessThan(
      order(mocks.completeRestartRecoveryTerminalDelivery),
    );
  });

  it("uses a distinct transcript receipt key after progress with the same send key", async () => {
    mocks.dispatchChannelMessageAction
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-progress" }))
      .mockResolvedValueOnce(jsonResult({ ok: true, messageId: "tg-terminal" }));
    const progress = await runTelegramTerminalAction({
      message: "progress",
      sourceReplyFinal: false,
      toolCallId: "message-call-shared-progress",
    });
    const terminal = await runTelegramTerminalAction();
    mocks.beginRestartRecoveryTerminalDelivery.mockResolvedValueOnce("already-delivered");
    const repeatedTerminal = await runTelegramTerminalAction({
      message: "repeated terminal",
      idempotencyKey: "idem-repeated-terminal",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript.mock.calls).toHaveLength(2);
    expect(appendTranscriptCall(0)?.idempotencyKey).toBe("idem-terminal");
    expect(appendTranscriptCall(1)?.idempotencyKey).toBe(
      "idem-terminal:terminal-receipt:channel-user:v1:terminal",
    );
    for (const { respond } of [progress, terminal, repeatedTerminal]) {
      expect(firstRespondCall(respond)[0]).toBe(true);
    }
    expect(firstRespondCall(repeatedTerminal.respond)[1]).toMatchObject({
      status: "already_delivered",
      delivered: false,
    });
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(2);
  });

  it.each([
    "receipt finalization fails",
    "transcript mirroring is rejected",
    "transcript mirroring throws",
  ])("preserves a delivered terminal reply when %s", async (failure) => {
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "tg-2" }),
    );
    if (failure === "receipt finalization fails") {
      mocks.completeRestartRecoveryTerminalDelivery.mockRejectedValueOnce(
        new Error("receipt store unavailable"),
      );
    } else if (failure === "transcript mirroring is rejected") {
      mocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
        ok: false,
        code: "blocked",
        reason: "transcript write rejected",
      });
    } else {
      mocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
        new Error("transcript unavailable"),
      );
    }
    const sessionKey = "agent:main:telegram:direct:chat-123";

    const { respond } = await runTelegramTerminalAction();

    expectSuccess(respond, { ok: true, messageId: "tg-2" });
    expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
    expectCall(mocks.completeRestartRecoveryTerminalDelivery, {
      sessionId: terminalRequest.sessionId,
      sessionKey,
      sourceTurnId: terminalRequest.sourceTurnId,
    });
  });

  it("mirrors a Slack DM send after target resolution strips its user prefix", async () => {
    registerMessageActionPlugin({
      id: "slack",
      threading: {
        threadAddressing: "message",
        matchesToolContextTarget: ({ target, toolContext }) =>
          target.toLowerCase() ===
          toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
      },
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

  it("preserves source transcript mirror order before message.action responses", async () => {
    const firstMirrorDeferred = createDeferred<SessionTranscriptAppendResult>();
    registerMessageActionPlugin();
    mocks.dispatchChannelMessageAction.mockResolvedValue(
      jsonResult({ ok: true, messageId: "tg-ordered" }),
    );
    mocks.appendAssistantMessageToSessionTranscript
      .mockReturnValueOnce(firstMirrorDeferred.promise)
      .mockResolvedValueOnce(transcriptResult("message-second"));

    const first = startRequest(
      createTelegramSourceSendRequest(
        "chat-123",
        "first visible reply",
        "idem-ordered-source-message-action-1",
      ),
      {
        client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
      },
    );
    await waitForCalls(mocks.appendAssistantMessageToSessionTranscript);
    const second = startRequest(
      createTelegramSourceSendRequest(
        "chat-123",
        "second visible reply",
        "idem-ordered-source-message-action-2",
      ),
      {
        requestId: "2",
        client: agentRuntimeClient("agent:main:telegram:direct:chat-123"),
      },
    );

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();
    expect(appendTranscriptCall(0)).toMatchObject({ text: "first visible reply" });

    firstMirrorDeferred.resolve(transcriptResult("message-first"));
    await first.promise;
    await second.promise;

    expect(firstRespondCall(first.respond)[0]).toBe(true);
    expect(firstRespondCall(second.respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(appendTranscriptCall(1)).toMatchObject({ text: "second visible reply" });
  });

  it.each(["unknown outcome", "partial delivery"] as const)(
    "preserves terminal source reply receipts after %s",
    async (failure) => {
      const partial = failure === "partial delivery";
      const cause = new Error(partial ? "upload failed" : "provider timeout");
      mocks.dispatchChannelMessageAction.mockRejectedValueOnce(
        partial
          ? createChannelPartialDeliveryError(cause, {
              messageIds: ["caption_msg"],
              visibleReplySent: true,
            })
          : cause,
      );
      const { respond } = await runTelegramTerminalAction();
      const response = firstRespondCall(respond);
      expect(response[0]).toBe(false);
      expect(response[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
      expect(response[2]?.retryable).toBe(partial ? false : undefined);
      expect(mocks.beginRestartRecoveryTerminalDelivery).toHaveBeenCalledOnce();
      expect(mocks.cancelRestartRecoveryTerminalDelivery).not.toHaveBeenCalled();
      expect(mocks.completeRestartRecoveryTerminalDelivery).toHaveBeenCalledTimes(partial ? 1 : 0);
      if (partial) {
        expect(response[2]?.details).toMatchObject({
          partialDelivery: { messageIds: ["caption_msg"], visibleReplySent: true },
        });
        expect(JSON.stringify(response[2])).toContain("caption_msg");
        expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      } else {
        expect(response[2]?.details).toBeUndefined();
      }
    },
  );

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
          params: { message: "hello" },
          accountId: "secondary",
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
        params: { to: "explicit-room", message: "hello" },
      });

      expectFailure(respond, {
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

    it.each(["dispatch", "handoff"] as const)(
      "fences canonical outbound send at %s when runtime authority closes",
      async (boundary) => {
        const delivery = holdDelivery(boundary);
        const authority = liveAuthority();
        const sessionKey = "agent:main:twitch:group:explicit-room";
        const request = runMessageActionRequest(
          {
            channel: "twitch",
            params: { to: "explicit-room", message: "must not escape" },
            sessionKey,
          },
          agentRuntimeClient(sessionKey),
          authority.context,
        );
        await delivery.entered.promise;
        authority.revoke();
        delivery.release.resolve();
        expectAuthorityDenied((await request).respond);
        expect(deliveryCall()?.skipQueue).toBe(true);
        expect(delivery.platformSend).not.toHaveBeenCalled();
        expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      },
    );
  });

  it("uses signed sender group policy without granting gateway send host reads", async () => {
    const plugin = registerMessageActionPlugin({
      chatType: "group",
    });
    const resolveToolPolicy = vi.fn(({ senderId }: { senderId?: string | null }) =>
      senderId === "blocked-sender" ? { deny: ["read"] } : undefined,
    );
    plugin.groups = { resolveToolPolicy };
    const sessionKey = "agent:work:telegram:group:ops";

    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        params: { to: "ops", message: "chart", mediaUrl: "chart.png" },
        requesterSenderId: "forged-allowed-sender",
        sessionKey,
        agentId: "work",
      },
      messageActionClientForTests(sessionKey, {
        agentId: "work",
        messageActionContext: {
          expiresAtMs: Date.now() + 60_000,
          requesterSenderId: "blocked-sender",
        },
      }),
      makeContext(() => ({
        agents: { entries: { main: {}, work: {} } },
        tools: { allow: ["read"] },
      })),
    );

    expect(firstRespondCall(respond)[0]).toBe(true);
    expectCall(resolveToolPolicy, { groupId: "ops", senderId: "blocked-sender" });
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
          messageActionClientForTests(sessionKey, {
            agentId: "work",
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              requesterSenderId: "allowed-id",
              requesterSenderName: "Blocked Sender",
              requesterSenderUsername: "blocked-user",
              requesterSenderE164: "+15551234567",
            },
          }),
          makeContext(() => ({
            agents: { entries: { main: {}, work: {} } },
            tools: {
              allow: ["read"],
              toolsBySender: { "username:blocked-user": { deny: ["read"] } },
            },
          })),
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
