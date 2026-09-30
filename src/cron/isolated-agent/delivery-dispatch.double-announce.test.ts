import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDescendantRunAwaitingSettleFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import * as deliveryQueueSqlite from "../../infra/delivery-queue-sqlite.js";

const directCronCompletionRetention = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
};

const {
  appendAssistantMessageToSessionTranscriptMock,
  commitBackgroundResultToSessionMock,
  hasUnsettledCronDescendantsMock,
  deliverOutboundPayloadsMock,
  ensureOutboundSessionEntryMock,
  loadCronSessionEntryLatestMock,
  maybeApplyTtsToPayloadMock,
  retireSessionMcpRuntimeMock,
  resolveOutboundSessionRouteMock,
} = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscriptMock: vi.fn().mockResolvedValue({
    ok: true,
    sessionFile: "session.jsonl",
    messageId: "mirror-message",
  }),
  commitBackgroundResultToSessionMock: vi.fn().mockResolvedValue({
    ok: true,
    messageId: "current-completion-message",
  }),
  hasUnsettledCronDescendantsMock: vi.fn().mockResolvedValue(false),
  deliverOutboundPayloadsMock: vi.fn().mockResolvedValue([{ ok: true }]),
  ensureOutboundSessionEntryMock: vi.fn().mockResolvedValue(undefined),
  loadCronSessionEntryLatestMock: vi.fn(),
  maybeApplyTtsToPayloadMock: vi.fn(async (params: { payload: unknown }) => params.payload),
  retireSessionMcpRuntimeMock: vi.fn().mockResolvedValue(true),
  resolveOutboundSessionRouteMock: vi.fn().mockResolvedValue(null),
}));
const channelTransformMock = vi.hoisted(() => ({
  current: undefined as ChannelMessagingAdapter["transformReplyPayload"],
}));

vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>();
  return {
    ...actual,
    getLoadedChannelPluginForRead: (id: string) =>
      channelTransformMock.current
        ? { id, meta: {}, messaging: { transformReplyPayload: channelTransformMock.current } }
        : actual.getLoadedChannelPluginForRead(id),
  };
});

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(
    ({
      cfg,
      agentId,
      sessionKey,
    }: {
      cfg?: { session?: { mainKey?: string; scope?: string } };
      agentId: string;
      sessionKey: string;
    }) => {
      const mainKey = cfg?.session?.mainKey?.trim().toLowerCase() || "main";
      const normalizedAgentId = agentId.trim().toLowerCase() || "main";
      const raw = sessionKey.trim();
      const aliases = new Set([
        "main",
        mainKey,
        `agent:${normalizedAgentId}:main`,
        `agent:${normalizedAgentId}:${mainKey}`,
        `agent:main:main`,
        `agent:main:${mainKey}`,
      ]);
      if (!aliases.has(raw)) {
        return sessionKey;
      }
      return cfg?.session?.scope === "global" ? "global" : `agent:${normalizedAgentId}:${mainKey}`;
    },
  ),
  resolveAgentMainSessionKey: vi.fn(
    ({ cfg, agentId }: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
      `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  ),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  countPendingDescendantRuns: async () => 0,
  getLatestLiveSubagentRunByChildSessionKey: () => null,
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  hasUnsettledCronDescendants: hasUnsettledCronDescendantsMock,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  ensureOutboundSessionEntry: ensureOutboundSessionEntryMock,
  resolveOutboundSessionRoute: resolveOutboundSessionRouteMock,
}));

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
}));

vi.mock("../../sessions/background-session-result.js", () => ({
  commitBackgroundResultToSession: commitBackgroundResultToSessionMock,
}));

vi.mock("../../gateway/server-methods/chat-assistant-content.js", () => ({
  buildAssistantReplyContent: vi.fn(),
  hasAssistantDisplayMediaContent: vi.fn(),
  hasManagedOutgoingAssistantContent: vi.fn(),
}));

vi.mock("../../gateway/managed-image-attachments.js", () => ({
  attachManagedOutgoingMediaToMessage: vi.fn(),
  removeManagedOutgoingMediaBlocks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./session.js", () => ({
  loadCronSessionEntryLatest: loadCronSessionEntryLatestMock,
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ ok: true, deleted: true }),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: maybeApplyTtsToPayloadMock,
}));

vi.mock("./subagent-followup-hints.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("./subagent-followup.runtime.js", () => ({
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { callGateway } from "../../gateway/call.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { withTempCronHome } from "../isolated-agent.test-harness.js";
import type { CronDelivery } from "../types.js";
import {
  dispatchCronDelivery,
  queueCronMessageToolDeliveryAwareness,
} from "./delivery-dispatch.js";
import { hasUnsettledCronDescendants } from "./delivery-subagent-registry.runtime.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.runtime.js";

type SourceOutcome = Parameters<typeof dispatchCronDelivery>[0]["sourceDeliveryOutcome"];
function messageToolOutcome(
  targets: SourceOutcome["visibleDeliveries"][number]["target"][],
  verified = true,
): SourceOutcome {
  return {
    visibleDeliveries: targets.map((target) => ({
      via: "message_tool",
      target,
      verifiedTarget: verified,
    })),
    verifiedMessageToolDelivery: verified,
    satisfiesSourceDelivery: verified,
    unverifiedMessageToolDelivery: !verified,
  };
}

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;
type ResolvedOutboundSessionRoute = NonNullable<
  Awaited<ReturnType<typeof resolveOutboundSessionRoute>>
>;

function makeResolvedDelivery(
  overrides: Partial<SuccessfulDeliveryResolution> = {},
): SuccessfulDeliveryResolution {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryRequested?: boolean;
  runStartedAt?: number;
  sessionTarget?: string;
  deliveryBestEffort?: boolean;
  spawnOnlyHandoff?: boolean;
  runSessionKey?: string;
  resolvedDeliveryMode?: "explicit" | "implicit";
}): Parameters<typeof dispatchCronDelivery>[0] {
  const resolvedDelivery = {
    ...makeResolvedDelivery(),
    mode: overrides.resolvedDeliveryMode ?? "explicit",
  } satisfies Extract<DeliveryTargetResolution, { ok: true }>;
  const delivery: CronDelivery = {
    mode: "announce",
    bestEffort: overrides.deliveryBestEffort,
  };
  const runStartedAt = overrides.runStartedAt ?? Date.now();
  return {
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: overrides.sessionTarget ?? "isolated",
      sessionKey:
        overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
      deleteAfterRun: false,
      delivery,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main:cron:test-job",
    sourceSessionKey:
      overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
    sourceSessionGeneration:
      overrides.sessionTarget === "current"
        ? { sessionId: "source-session-id", lifecycleRevision: "source-lifecycle-revision" }
        : undefined,
    runSessionKey: overrides.runSessionKey ?? "agent:main:cron:test-job",
    sessionId: "test-session-id",
    lifecycleRevision: "test-lifecycle-revision",
    sessionUpdatedAt: 1_000,
    runStartedAt,
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryPlan: resolveCronDeliveryPlan({ delivery }),
    deliveryRequested: overrides.deliveryRequested ?? true,
    undeliveredRunStatus: "ok",
    skipDelivery: undefined,
    spawnOnlyHandoff: overrides.spawnOnlyHandoff ?? false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: overrides.deliveryBestEffort ?? false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
  };
}

const requireRecord = createRequireRecord("object", "expected-label");

function outboundDeliveryCall(callIndex = 0) {
  const call = vi.mocked(deliverOutboundPayloads).mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected outbound delivery call ${callIndex}`);
  }
  return requireRecord(call[0], `outbound delivery call ${callIndex}`);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

function expectDeliveryCall(callIndex: number, expected: Record<string, unknown>) {
  expectFields(outboundDeliveryCall(callIndex), expected);
}

function mockResolvedOutboundRoute(
  overrides: Partial<ResolvedOutboundSessionRoute> = {},
): ResolvedOutboundSessionRoute {
  const route: ResolvedOutboundSessionRoute = {
    sessionKey: "agent:main:telegram:direct:123456",
    baseSessionKey: "agent:main:telegram:direct:123456",
    peer: { kind: "direct", id: "123456" },
    chatType: "direct",
    from: "telegram:123456",
    to: "123456",
    ...overrides,
  };
  vi.mocked(resolveOutboundSessionRoute).mockResolvedValue(route);
  return route;
}

const buttons = { telegram: { buttons: [[{ text: "Open", url: "https://example.test" }]] } };

function structuredParams(
  payloads: Parameters<typeof dispatchCronDelivery>[0]["deliveryPayloads"],
  text: string,
) {
  const params = makeBaseParams({});
  params.deliveryPayloadHasStructuredContent = true;
  params.deliveryPayloads = payloads;
  params.summary = text;
  params.outputText = text;
  return params;
}

function expectDelivered(state: Awaited<ReturnType<typeof dispatchCronDelivery>>) {
  expect(state.deliveryAttempted).toBe(true);
  expect(state.delivered).toBe(true);
}

function emptyParams(spawnOnlyHandoff = false, deliveryBestEffort = false) {
  const params = makeBaseParams({ spawnOnlyHandoff, deliveryBestEffort, synthesizedText: "" });
  params.synthesizedText = undefined;
  params.deliveryPayloads = [];
  params.summary = undefined;
  params.outputText = undefined;
  return params;
}

function deletingRunParams(sessionTarget = "isolated") {
  const params = makeBaseParams({ synthesizedText: "Delivered report", sessionTarget });
  params.job.deleteAfterRun = true;
  return params;
}

function expectSessionDeleted() {
  expect(callGateway).toHaveBeenCalledWith({
    method: "sessions.delete",
    params: {
      key: "agent:main:cron:test-job",
      deleteTranscript: true,
      emitLifecycleHooks: false,
      expectedSessionId: "test-session-id",
      expectedLifecycleRevision: "test-lifecycle-revision",
      expectedSessionUpdatedAt: 1_000,
    },
    timeoutMs: 10_000,
  });
}

describe("dispatchCronDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverOutboundPayloadsMock.mockReset().mockResolvedValue([{ ok: true }]);
    vi.spyOn(deliveryQueueSqlite, "getDeliveryQueueEntryStatus").mockReturnValue(undefined);
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(false);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(false);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(retireSessionMcpRuntime).mockResolvedValue(true);
    vi.mocked(resolveOutboundSessionRoute).mockResolvedValue(null);
    vi.mocked(ensureOutboundSessionEntry).mockResolvedValue(undefined);
    vi.mocked(enqueueSystemEvent).mockReset();
    vi.mocked(appendAssistantMessageToSessionTranscript).mockResolvedValue({
      ok: true,
      target: {
        agentId: "main",
        sessionId: "test-session-id",
        sessionKey: "agent:main:main",
        storePath: "/tmp/sessions.json",
      },
      messageId: "mirror-message",
    });
    commitBackgroundResultToSessionMock.mockResolvedValue({
      ok: true,
      messageId: "current-completion-message",
    });
    loadCronSessionEntryLatestMock.mockReturnValue({
      sessionId: "test-session-id",
      lifecycleRevision: "test-lifecycle-revision",
    });
    maybeApplyTtsToPayloadMock.mockReset().mockImplementation(async (params) => params.payload);
    channelTransformMock.current = undefined;
  });

  afterEach(() => {
    channelTransformMock.current = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("suppresses incomplete descendant output while settlement is queued", async () => {
    const params = makeBaseParams({ synthesizedText: "on it" });
    const descendant: SubagentRunRecord = {
      runId: "descendant-run",
      childSessionKey: "agent:main:subagent:descendant",
      requesterSessionKey: params.runSessionKey,
      requesterDisplayKey: params.runSessionKey,
      task: "Reconcile findings",
      cleanup: "keep",
      createdAt: params.runStartedAt,
      execution: { status: "terminal", endedAt: params.runStartedAt + 1 },
      delivery: { status: "in_progress", disposition: "session_queued" },
    };
    vi.mocked(hasUnsettledCronDescendants).mockImplementation(async (key) =>
      hasDescendantRunAwaitingSettleFromRuns(new Map([[descendant.runId, descendant]]), key),
    );
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue("Incomplete child finding");
    const state = await dispatchCronDelivery(params);
    expect(state.deliveryAttempted).toBe(true);
    expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(1);
    expect(readDescendantSubagentFallbackReply).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryError).toBe("cron descendants are still active without a final reply");
  });

  it("records channel transform suppression before TTS, custody, transport, or mirroring", async () => {
    const transformReplyPayload = vi.fn(() => null);
    channelTransformMock.current = transformReplyPayload;
    const params = makeBaseParams({ synthesizedText: "private cron reply" });

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(false);
    expect(state.deliverySuppressionReason).toBe("channel_transform");
    expect(maybeApplyTtsToPayloadMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliveryQueueSqlite.getDeliveryQueueEntryStatus).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("records identityless transport after an earlier suppression as unknown", async () => {
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
      });
      params.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "suppressed",
        reason: "adapter_returned_no_identity",
      });
      return [];
    });
    const state = await dispatchCronDelivery(makeBaseParams({ synthesizedText: "Report ready" }));
    expect(state.deliveryState).toMatchObject({
      status: "unknown",
      error: "cron delivery outcome is unknown: adapter_returned_no_identity",
    });
    expect(state.delivered).not.toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("records text emptied by TTS as a delivery failure", async () => {
    const params = makeBaseParams({ synthesizedText: "Report ready" });
    params.ttsAuto = "always";
    maybeApplyTtsToPayloadMock.mockResolvedValue({});
    const state = await dispatchCronDelivery(params);
    expect(state.deliveryError).toBe("cron delivery payload was empty after TTS");
    expect(state.delivered).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "settles failed one-shot cleanup with bestEffort=%s",
    async (bestEffort) => {
      const params = deletingRunParams();
      params.deliveryBestEffort = bestEffort;
      params.job.delivery = { mode: "announce", bestEffort };
      params.beforeSessionDelete = vi.fn();
      if (bestEffort) {
        vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(new Error("send rejected"));
      } else {
        vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (delivery) => {
          delivery.onPayloadDeliveryOutcome?.({
            index: 0,
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
          });
          return [];
        });
      }
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).not.toBe(true);
      expect(callGateway).toHaveBeenCalledTimes(bestEffort ? 1 : 0);
      expect(params.beforeSessionDelete).toHaveBeenCalledTimes(bestEffort ? 1 : 0);
      if (bestEffort) {
        expectSessionDeleted();
      } else {
        expect(state.deliverySuppressionReason).toBeUndefined();
        expect(state.deliveryError).toContain("suppressed");
      }
    },
  );

  it("keeps one transformed cron fallback source without duplicating it", async () => {
    channelTransformMock.current = vi.fn(({ payload }) => ({
      ...payload,
      ...(payload.text ? { text: `${payload.text}!` } : {}),
      ...(payload.fallbackText
        ? { fallbackText: { ...payload.fallbackText, text: `${payload.fallbackText.text}!` } }
        : {}),
    }));
    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "Cron summary" },
      { channelData: { telegram: { buttons: [[{ text: "Open", url: "https://example.test" }]] } } },
    ];
    params.summary = "Cron summary";
    params.outputText = "Cron summary";

    await dispatchCronDelivery(params);

    expectDeliveryCall(0, {
      payloads: [
        { text: "Cron summary!" },
        {
          channelData: {
            telegram: { buttons: [[{ text: "Open", url: "https://example.test" }]] },
          },
          fallbackText: { text: "Cron summary!", replacesPayloadIndex: 0 },
        },
      ],
    });
    expect(channelTransformMock.current).toHaveBeenCalledTimes(2);
  });

  it("does not regenerate a cron fallback source vetoed by the channel transform", async () => {
    channelTransformMock.current = vi.fn(({ payload }) => (payload.text ? null : payload));
    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "Private summary" },
      { channelData: { telegram: { reaction: { emoji: "👍", replyToId: "123" } } } },
    ];
    params.summary = "Private summary";
    params.outputText = "Private summary";

    await dispatchCronDelivery(params);

    expectDeliveryCall(0, {
      payloads: [{ channelData: { telegram: { reaction: { emoji: "👍", replyToId: "123" } } } }],
    });
    expect(channelTransformMock.current).toHaveBeenCalledTimes(2);
  });

  it("uses non-empty summary text when structured direct payloads are textless", async () => {
    const params = structuredParams(
      [{ text: "   " }, {}],
      "Pablo Daily Summary\n- One task needs attention.",
    );

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ text: "Pablo Daily Summary\n- One task needs attention." }],
    });
    expectDelivered(state);
  });

  it("adds generic fallback text to metadata-only direct payloads", async () => {
    const params = structuredParams([{ text: "   ", channelData: buttons }], "Report ready");
    const state = await dispatchCronDelivery(params);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [
        { text: "Report ready" },
        { fallbackText: { text: "Report ready", replacesPayloadIndex: 0 }, channelData: buttons },
      ],
    });
    expectDelivered(state);
  });

  it("does not attach fallback hints when the direct summary is silent", async () => {
    const params = structuredParams(
      [{ text: SILENT_REPLY_TOKEN, channelData: buttons }],
      SILENT_REPLY_TOKEN,
    );
    const state = await dispatchCronDelivery(params);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, { payloads: [{ channelData: buttons }] });
    expectDelivered(state);
  });

  it("skips announce fallback after verified message-tool source delivery", async () => {
    const params = makeBaseParams({ synthesizedText: "Fallback cron summary." });
    params.sourceDeliveryOutcome = messageToolOutcome([
      { tool: "message", provider: "telegram", to: "123456" },
    ]);
    const state = await dispatchCronDelivery(params);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectDelivered(state);
  });

  it("queues message-tool awareness to the resolved thread for implicit thread evidence", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:telegram:direct:123456:thread:42",
      baseSessionKey: "agent:main:telegram:direct:123456",
      to: "telegram:123456",
      threadId: "42",
    });
    await queueCronMessageToolDeliveryAwareness({
      cfg: {},
      ...makeBaseParams({ runStartedAt: 1_000 }),
      resolvedDelivery: makeResolvedDelivery({ threadId: "42" }),
      sourceDeliveryOutcome: messageToolOutcome([
        {
          tool: "message",
          provider: "telegram",
          to: "123456",
          threadImplicit: true,
          mediaUrls: ["https://example.test/weather-map.png?token=secret"],
        },
      ]),
    });

    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "42",
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      "A scheduled automation delivered this message to this channel:\nweather-map.png",
      {
        sessionKey: "agent:main:telegram:direct:123456:thread:42",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:42",
      },
    );
  });

  it("defers same-source message-tool awareness until requested", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:webchat:direct:owner",
      baseSessionKey: "agent:main:webchat:direct:owner",
      to: "webchat:owner",
    });
    const params = makeBaseParams({ sessionTarget: "current", runStartedAt: 1_000 });

    const queueSourceAwareness = await queueCronMessageToolDeliveryAwareness({
      cfg: {},
      ...params,
      deferredTargetSessionKey: params.sourceSessionKey,
      resolvedDelivery: makeResolvedDelivery({ channel: "webchat", to: "owner" }),
      sourceDeliveryOutcome: messageToolOutcome([
        {
          tool: "message",
          provider: "webchat",
          to: "owner",
          text: "Current-session completion.",
        },
      ]),
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await queueSourceAwareness?.();

    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      "A scheduled automation delivered this message to this channel:\nCurrent-session completion.",
      {
        sessionKey: "agent:main:webchat:direct:owner",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:webchat::owner:",
      },
    );
  });

  it("keeps same-recipient message-tool awareness separate across channels", async () => {
    vi.mocked(resolveOutboundSessionRoute)
      .mockResolvedValueOnce({
        sessionKey: "agent:main:telegram:direct:123456",
        baseSessionKey: "agent:main:telegram:direct:123456",
        peer: { kind: "direct", id: "123456" },
        chatType: "direct",
        from: "telegram:123456",
        to: "123456",
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:main:openclaw-weixin:direct:123456",
        baseSessionKey: "agent:main:openclaw-weixin:direct:123456",
        peer: { kind: "direct", id: "123456" },
        chatType: "direct",
        from: "openclaw-weixin:123456",
        to: "123456",
      });

    await queueCronMessageToolDeliveryAwareness({
      cfg: {},
      ...makeBaseParams({ runStartedAt: 1_000 }),
      resolvedDelivery: makeResolvedDelivery(),
      sourceDeliveryOutcome: messageToolOutcome(
        [
          {
            tool: "message",
            provider: "telegram",
            to: "123456",
            text: "Shared cron update.",
          },
          {
            tool: "message",
            provider: "openclaw-weixin",
            to: "123456",
            text: "Shared cron update.",
          },
        ],
        false,
      ),
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "A scheduled automation delivered this message to this channel:\nShared cron update.",
      {
        sessionKey: "agent:main:telegram:direct:123456",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      },
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "A scheduled automation delivered this message to this channel:\nShared cron update.",
      {
        sessionKey: "agent:main:openclaw-weixin:direct:123456",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:openclaw-weixin::123456:",
      },
    );
  });

  it("bestEffort delivery still suppresses stale interim text while descendants run", async () => {
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(true);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({
      synthesizedText: "on it, pulling everything together",
      deliveryBestEffort: true,
    });
    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("early return (stale interim suppression) sets deliveryAttempted=true so timer skips enqueueSystemEvent", async () => {
    vi.mocked(hasUnsettledCronDescendants)
      .mockResolvedValueOnce(true) // initial check → hadDescendants=true, enters wait block
      .mockResolvedValueOnce(false); // second check after wait → settlement complete
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "on it, pulling everything together" });
    const state = await dispatchCronDelivery(params);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryError).toBe("cron descendants completed without a final reply");
  });

  it.each([
    ["active threaded best-effort", true, "42", true],
    ["completed direct", false, undefined, false],
  ] as const)(
    "delivers %s accepted child results without parent text",
    async (_name, activeDescendants, threadId, deliveryBestEffort) => {
      const childReply = "Completed child result visible to the user.";
      if (activeDescendants) {
        vi.mocked(hasUnsettledCronDescendants)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
      }
      vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(childReply);

      const params = emptyParams(true, deliveryBestEffort);
      params.resolvedDelivery = makeResolvedDelivery({ threadId });

      const state = await dispatchCronDelivery(params);

      expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(activeDescendants ? 1 : 0);
      expect(readDescendantSubagentFallbackReply).toHaveBeenCalledWith({
        sessionKey: params.runSessionKey,
        runStartedAt: params.runStartedAt,
      });
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expectDeliveryCall(0, {
        channel: "telegram",
        to: "123456",
        ...(threadId === undefined ? {} : { threadId }),
        payloads: [{ text: childReply }],
      });
      expect(state.delivered).toBe(true);
      expect(state.deliveryAttempted).toBe(true);
    },
  );

  it.each([
    {
      name: "active child times out",
      activeDescendants: 1,
      error: "cron child-session handoff timed out before producing a final assistant payload",
    },
    {
      name: "completed child has no output",
      activeDescendants: 0,
      error: "cron child-session handoff completed without a final assistant payload",
    },
  ])("fails an accepted spawn-only handoff when $name", async ({ activeDescendants, error }) => {
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(activeDescendants > 0);
    const params = emptyParams(true);

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({
      disposition: { kind: "error", error },
      delivered: false,
      deliveryAttempted: true,
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("preserves abort precedence when an accepted child handoff is interrupted", async () => {
    const abortReason = "scheduled run aborted while waiting for its child";
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValueOnce(true).mockResolvedValue(false);
    const params = emptyParams(true);
    params.abortSignal = AbortSignal.abort(new Error(abortReason));
    params.isAborted = () => true;
    params.abortReason = () => abortReason;

    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      disposition: { kind: "error", error: abortReason },
    });
    expect(readDescendantSubagentFallbackReply).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("keeps an empty no-spawn parent silent", async () => {
    const params = emptyParams();

    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(readDescendantSubagentFallbackReply).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(false);
  });

  it("uses the run-scoped session key for isolated cron descendant fallback delivery", async () => {
    const runStartedAt = 1_000;
    const agentSessionKey = "agent:main:cron:daily-monitor";
    const runSessionKey = "agent:main:cron:daily-monitor:run:test-session-id";
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockImplementation(async (params) =>
      params.sessionKey === runSessionKey
        ? "Run-scoped child result, everything finished successfully."
        : undefined,
    );

    const params = makeBaseParams({
      synthesizedText: "on it",
      runStartedAt,
      runSessionKey,
    });
    params.agentSessionKey = agentSessionKey;

    const state = await dispatchCronDelivery(params);

    expect(hasUnsettledCronDescendants).toHaveBeenCalledWith(runSessionKey);
    expect(hasUnsettledCronDescendants).not.toHaveBeenCalledWith(agentSessionKey);
    expect(readDescendantSubagentFallbackReply).toHaveBeenCalledWith({
      sessionKey: runSessionKey,
      runStartedAt,
    });
    expectDelivered(state);
    expectDeliveryCall(0, {
      payloads: [{ text: "Run-scoped child result, everything finished successfully." }],
    });
  });

  it("applies TTS before delivery and mirrors spoken text without voice filenames", async () => {
    const speech = {
      text: "Briefing",
      spokenText: "Briefing",
      audioAsVoice: true,
      mediaUrl: "file:///tmp/voice.mp3",
      mediaUrls: ["file:///tmp/chart.png", "file:///tmp/narration.ogg"],
    };
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (delivery) => {
      delivery.onPayload?.({
        text: "Briefing",
        audioAsVoice: true,
        mediaUrls: [...speech.mediaUrls, speech.mediaUrl],
      });
      return [{ channel: "telegram", messageId: "spoken-report" }];
    });
    maybeApplyTtsToPayloadMock.mockResolvedValue(speech);
    const params = makeBaseParams({ synthesizedText: "[[tts]] Briefing", runStartedAt: 1_000 });
    params.cfgWithAgentDefaults = { tts: { auto: "tagged", provider: "microsoft" } };
    const state = await dispatchCronDelivery(params);
    expectDelivered(state);
    expect(maybeApplyTtsToPayloadMock).toHaveBeenCalledExactlyOnceWith({
      payload: { text: "[[tts]] Briefing" },
      cfg: params.cfgWithAgentDefaults,
      channel: "telegram",
      kind: "final",
      agentId: "main",
      accountId: undefined,
      ttsAuto: undefined,
    });
    expectDeliveryCall(0, { payloads: [speech] });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Briefing\nchart.png", mediaUrls: undefined }),
    );
  });

  it("mirrors the effective outbound payload after send hooks rewrite delivery text", async () => {
    mockResolvedOutboundRoute();
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayload?.({ text: "Redacted cron update.", mediaUrls: [] });
      return [{ channel: "telegram", messageId: "tg-redacted" }];
    });

    const params = makeBaseParams({
      synthesizedText: "Sensitive cron update.",
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expectDelivered(state);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123456",
        text: "Redacted cron update.",
        mediaUrls: undefined,
      }),
    );
    expect(
      vi.mocked(appendAssistantMessageToSessionTranscript).mock.calls[0]?.[0],
    ).not.toHaveProperty("deliveryMirror");
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Redacted cron update.", {
      sessionKey: "agent:main:main",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "A scheduled automation delivered this message to this channel:\nRedacted cron update.",
      {
        sessionKey: "agent:main:telegram:direct:123456",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      },
    );
  });

  it("keeps effective media-only payloads in main-session awareness before suppressing the mirror", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayload?.({
        text: "",
        mediaUrls: ["https://example.com/main-chart.png"],
      });
      return [{ channel: "telegram", messageId: "tg-main-media" }];
    });

    const params = makeBaseParams({
      synthesizedText: "Main session briefing.",
      runStartedAt: 1_000,
    });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "Main session briefing.", mediaUrl: "https://example.com/main-chart.png" },
    ] as never;
    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("main-chart.png", {
      sessionKey: "agent:main:main",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
    });
  });

  it("mirrors media-only main-session deliveries because awareness has no transcript text", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });

    const params = makeBaseParams({ runStartedAt: 1_000 });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [{ mediaUrl: "https://example.com/main-report.png" }] as never;
    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "main-report.png",
        mediaUrls: undefined,
      }),
    );
  });

  it("mirrors main-session deliveries when awareness queueing is suppressed", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });

    const params = makeBaseParams({
      synthesizedText: "Best-effort main session briefing complete.",
      deliveryBestEffort: true,
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "Best-effort main session briefing complete.",
        mediaUrls: undefined,
      }),
    );
  });

  it("carries the exact cron run's required creator to a newly delivered destination", async () => {
    mockResolvedOutboundRoute({ to: "telegram:123456" });
    const params = makeBaseParams({
      synthesizedText: "Required cron delivery",
      runSessionKey: "agent:main:cron:job:run:required-run",
    });
    params.cfgWithAgentDefaults = {
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: { sessions: { others: "none" }, agents: "*", scopes: [], sandbox: "required" },
          },
        },
      },
    };
    const state = await dispatchCronDelivery(params);
    expect(state.delivered).toBe(true);
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionKey: params.runSessionKey,
      }),
    );
  });

  it.each(["", ":thread:42"])(
    "canonicalizes main aliases%s before awareness and mirroring",
    async (suffix) => {
      mockResolvedOutboundRoute({
        sessionKey: `agent:main:main${suffix}`,
        baseSessionKey: "agent:main:main",
        threadId: suffix ? "42" : undefined,
      });
      const params = makeBaseParams({ synthesizedText: "Custom main report", runStartedAt: 1_000 });
      params.cfgWithAgentDefaults = { session: { mainKey: "work" } };
      const state = await dispatchCronDelivery(params);
      expect(state.disposition).toBeUndefined();
      expect(state.delivered).toBe(true);
      expect(buildOutboundSessionContext).toHaveBeenCalledWith({
        cfg: params.cfgWithAgentDefaults,
        agentId: "main",
        sessionKey: `agent:main:work${suffix}`,
      });
      expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
        sourceSessionKey: "agent:main:cron:test-job",
        cfg: params.cfgWithAgentDefaults,
        channel: "telegram",
        accountId: undefined,
        route: expect.objectContaining({
          sessionKey: `agent:main:work${suffix}`,
          baseSessionKey: "agent:main:work",
        }),
      });
      if (suffix) {
        expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:main:work:thread:42",
            text: "Custom main report",
          }),
        );
      } else {
        expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      }
      expect(enqueueSystemEvent).toHaveBeenCalledWith("Custom main report", {
        sessionKey: "agent:main:work",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      });
    },
  );

  it("skips main-session awareness for isolated cron jobs with implicit delivery targets", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    const params = makeBaseParams({
      synthesizedText: "Implicit cron update.",
      resolvedDeliveryMode: "implicit",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("skips awareness text when direct delivery strips a silent caption", async () => {
    const params = makeBaseParams({});
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { mediaUrl: "https://example.com/image.png", text: "All done\n\nNO_REPLY" },
    ];
    params.outputText = "All done\n\nNO_REPLY";
    params.summary = "All done\n\nNO_REPLY";

    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ mediaUrl: "https://example.com/image.png", text: undefined }],
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps the cron run successful when awareness queueing throws after delivery", async () => {
    vi.mocked(enqueueSystemEvent).mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    const params = makeBaseParams({ synthesizedText: "Morning briefing complete." });
    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("retains a stale one-shot transcript without delivery or a fallback summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));

    const params = makeBaseParams({ synthesizedText: "Yesterday's morning briefing." });
    params.job.deleteAfterRun = true;
    params.beforeSessionDelete = vi.fn();
    params.job.state = {
      nextRunAtMs: Date.now() - (3 * 60 * 60_000 + 1),
    };

    const state = await dispatchCronDelivery(params);

    const deliveryError = expect.stringContaining(
      "scheduled at 2026-03-18T13:59:59.999Z, started 180m late",
    );
    expect(state).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
      deliveryAttempted: true,
      deliveryError,
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryState).toMatchObject({
      status: "not-delivered",
      delivered: false,
      error: deliveryError,
    });
    expect(state.deliveryState.deliverySuppressionReason).toBeUndefined();
    expect(params.beforeSessionDelete).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each(["scheduled on time", "zero schedule"])(
    "delivers a long-running job with %s",
    async (schedule) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));
      const params = makeBaseParams({ synthesizedText: "Long running report finished." });
      params.runStartedAt = Date.now() - (3 * 60 * 60_000 + 1);
      params.job.state = { nextRunAtMs: schedule === "zero schedule" ? 0 : params.runStartedAt };
      const state = await dispatchCronDelivery(params);
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expectDelivered(state);
    },
  );

  it.each(["deleted", "retired", "aborted", "survived", "archived"] as const)(
    "settles the deferred mirror when cleanup is %s",
    async (outcome) => {
      mockResolvedOutboundRoute({
        sessionKey: "agent:main:cron:test-job",
        baseSessionKey: "agent:main:cron:test-job",
      });
      const persistent = outcome === "survived" || outcome === "archived";
      const params = deletingRunParams(
        persistent ? "session:agent:main:cron:test-job" : "isolated",
      );
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      if (outcome === "archived") {
        const error = Object.assign(new Error("session changed"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { reason: "session-changed" },
        });
        vi.mocked(callGateway).mockRejectedValueOnce(error);
        loadCronSessionEntryLatestMock.mockReturnValue({
          sessionId: "test-session-id",
          lifecycleRevision: "test-lifecycle-revision",
          archivedAt: Date.now(),
        });
      } else if (outcome !== "deleted") {
        vi.mocked(callGateway).mockImplementationOnce(async () => {
          if (outcome === "aborted") {
            abort.abort(new Error("cron run aborted"));
          }
          throw new Error("gateway down");
        });
      }
      await dispatchCronDelivery(params);
      if (outcome === "deleted") {
        expectSessionDeleted();
      }
      if (persistent) {
        expect(retireSessionMcpRuntime).not.toHaveBeenCalled();
      }
      if (outcome === "retired") {
        expect(retireSessionMcpRuntime).toHaveBeenCalledWith({
          sessionId: "test-session-id",
          reason: "cron-delete-after-run-fallback",
        });
      }
      if (outcome === "retired" || outcome === "survived") {
        expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:main:cron:test-job",
            expectedSessionId: "test-session-id",
            expectedLifecycleRevision: "test-lifecycle-revision",
            text: "Delivered report",
          }),
        );
      } else {
        expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      }
      if (outcome === "archived") {
        expect(loadCronSessionEntryLatestMock).toHaveBeenCalledWith(
          expect.any(String),
          "agent:main:cron:test-job",
        );
      }
    },
  );

  it("skips deleteAfterRun cleanup for non-cron sessions", async () => {
    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    params.agentSessionKey = "agent:main:whatsapp:direct:+15551234567";
    params.job.deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
    });
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );
    expect(retireSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("cleans up the direct cron session when refused delivery is best-effort (deleteAfterRun)", async () => {
    const params = makeBaseParams({
      synthesizedText: "refused report",
      deliveryBestEffort: true,
    });
    params.resolvedDelivery = {
      ok: false,
      channel: "telegram",
      mode: "implicit",
      error: new Error("refusing inherited shared-bucket delivery target"),
    };
    params.job.deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
      deliveryError: "refusing inherited shared-bucket delivery target",
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "typed permanent rejection",
      new PlatformMessageNotDispatchedError("payload rejected", {
        cause: new Error("invalid payload"),
        retryable: false,
      }),
      "payload rejected | OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED | invalid payload",
    ],
    [
      "ambiguous send",
      Object.assign(new Error("read ECONNRESET after send"), { code: "ECONNRESET" }),
      "read ECONNRESET after send | ECONNRESET",
    ],
    ["permanent recipient error", new Error("chat not found"), "chat not found"],
  ])("does not retry %s", async (_name, error, message) => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(error);
    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "Do not duplicate me" }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.deliveryState).toMatchObject({ status: "not-delivered", error: message });
  });

  it("does not retry after an earlier payload returned no identity", async () => {
    mockResolvedOutboundRoute({ to: "telegram:123456" });
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "second payload stopped before final dispatch",
      {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      },
    );
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (deliveryParams) => {
      deliveryParams.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "adapter_returned_no_identity",
      });
      deliveryParams.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error: notDispatchedError,
        sentBeforeError: false,
        stage: "platform_send",
      });
      return [];
    });

    const params = makeBaseParams({ runStartedAt: 1_000 });
    params.deliveryPayloads = [{ text: "First payload." }, { text: "Second payload." }];
    params.outputText = "Second payload.";
    params.summary = "Second payload.";
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.deliveryState).toMatchObject({
      status: "not-delivered",
      error:
        "second payload stopped before final dispatch | OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED | connect ECONNREFUSED | ECONNREFUSED",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      [
        "A scheduled automation attempted to deliver to this channel, but delivery failed.",
        "Job: Test Job",
        "Target: telegram:123456",
        "Check automation history for delivery error details.",
        "One or more scheduled message payloads may already have been delivered.",
      ].join("\n"),
      {
        sessionKey: "agent:main:telegram:direct:123456",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456::failure",
      },
    );
  });

  it("adopts completion when a competing pending owner disappears during lookup", async () => {
    vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(
      new Error("Stable delivery intent is already queued"),
    );
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("pending")
      .mockReturnValueOnce("completed");
    vi.spyOn(deliveryQueueSqlite, "loadDeliveryQueueEntry").mockReturnValue(null);

    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "Concurrently completed cron update." }),
    );

    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("waits for a competing delivery and commits the adopted receipt route (#112710)", async () => {
    mockResolvedOutboundRoute();
    vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(
      new Error("Stable delivery intent is already queued"),
    );
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("pending")
      .mockReturnValueOnce("completed");
    vi.spyOn(deliveryQueueSqlite, "loadDeliveryQueueEntry").mockReturnValue({
      id: "cross-process-cron-intent",
      enqueuedAt: Date.now(),
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });

    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "Cross-process completed cron update." }),
    );

    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(ensureOutboundSessionEntry).toHaveBeenCalledExactlyOnceWith({
      sourceSessionKey: "agent:main:cron:test-job",
      cfg: expect.anything(),
      channel: "telegram",
      route: expect.objectContaining({ to: "123456", from: "telegram:123456" }),
    });
  });

  it("fails closed immediately for a stale ambiguous cross-process cron delivery", async () => {
    vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(
      new Error("Stable delivery intent is already queued"),
    );
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("pending");
    vi.spyOn(deliveryQueueSqlite, "loadDeliveryQueueEntry").mockReturnValue({
      id: "stale-cross-process-cron-intent",
      enqueuedAt: Date.now() - 60_000,
      retryCount: 0,
      platformSendStartedAt: Date.now() - 30_001,
      recoveryState: "send_attempt_started",
    });

    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "Stale ambiguous cron update." }),
    );

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(deliveryQueueSqlite.getDeliveryQueueEntryStatus).toHaveBeenCalledTimes(2);
  });

  it("continues best-effort delivery when the durable receipt store is unavailable", async () => {
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus).mockImplementationOnce(() => {
      throw new Error("SQLite receipt store unavailable");
    });
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Best-effort storage outage update." });
    params.deliveryBestEffort = true;

    const state = await dispatchCronDelivery(params);

    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    expectDeliveryCall(0, {
      bestEffort: true,
      completionRetention: directCronCompletionRetention,
    });
  });

  it("fails required delivery closed when the durable receipt store is unavailable", async () => {
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus).mockImplementationOnce(() => {
      throw new Error("SQLite receipt store unavailable");
    });

    await expect(
      dispatchCronDelivery(makeBaseParams({ synthesizedText: "Required storage outage update." })),
    ).rejects.toThrow("SQLite receipt store unavailable");
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("keeps regenerated signed media URLs on the same durable cron intent", async () => {
    vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("completed");
    const params = structuredParams(
      [
        {
          text: "Signed media report.",
          mediaUrl: "https://example.com/report.png?signature=first",
        },
      ],
      "Signed media report.",
    );
    params.runStartedAt = 1_000;
    expect((await dispatchCronDelivery(params)).delivered).toBe(true);
    params.deliveryPayloads = [
      { text: "Signed media report.", mediaUrl: "https://example.com/report.png?signature=second" },
    ];
    expect((await dispatchCronDelivery(params)).delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    const calls = vi.mocked(deliveryQueueSqlite.getDeliveryQueueEntryStatus).mock.calls;
    expect(calls[0]?.[1]).toBe("cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:");
    expect(calls[1]?.[1]).toBe(calls[0]?.[1]);
  });

  it("keeps colon-bearing account and recipient tuples on distinct durable intents", async () => {
    const first = makeBaseParams({ runStartedAt: 1_000, synthesizedText: "Account-scoped update" });
    first.resolvedDelivery = makeResolvedDelivery({ accountId: "a", to: "b:c", threadId: "42" });
    const second = makeBaseParams({
      runStartedAt: 1_000,
      synthesizedText: "Account-scoped update",
    });
    second.resolvedDelivery = makeResolvedDelivery({ accountId: "a:b", to: "c", threadId: "42" });
    expect((await dispatchCronDelivery(first)).delivered).toBe(true);
    expect((await dispatchCronDelivery(second)).delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    const firstIntent = outboundDeliveryCall(0).deliveryIntentId;
    const secondIntent = outboundDeliveryCall(1).deliveryIntentId;
    expect(firstIntent).toContain(":telegram:a:b%3Ac:42");
    expect(secondIntent).toContain(":telegram:a%3Ab:c:42");
    expect(secondIntent).not.toBe(firstIntent);
  });

  it("queues target-session awareness when direct cron delivery fails", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:telegram:direct:123456:thread:42",
      baseSessionKey: "agent:main:telegram:direct:123456",
      to: "telegram:123456",
      threadId: "42",
    });
    const deliveryError = new Error(
      "Call to 'sendMessage' failed! (400: Bad Request: message thread not found)",
    );
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(deliveryError);

    const params = makeBaseParams({
      synthesizedText: "This delivery will fail.",
      runStartedAt: 1_000,
    });
    params.resolvedDelivery = makeResolvedDelivery({ threadId: "42" });
    const state = await dispatchCronDelivery(params);
    expect(ensureOutboundSessionEntry).not.toHaveBeenCalled();

    expect(state.deliveryState).toMatchObject({
      status: "not-delivered",
      error: deliveryError.message,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      [
        "A scheduled automation attempted to deliver to this channel, but delivery failed.",
        "Job: Test Job",
        "Target: telegram:123456 thread 42",
        "Check automation history for delivery error details.",
        "No scheduled message was delivered.",
      ].join("\n"),
      {
        sessionKey: "agent:main:telegram:direct:123456:thread:42",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:42:failure",
      },
    );
  });

  it("persists the outbound route when a best-effort partial batch reaches the recipient (#112710)", async () => {
    mockResolvedOutboundRoute({ to: "telegram:123456" });
    const deliveryError = new Error("second payload failed");
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (deliveryParams) => {
      deliveryParams.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error: deliveryError,
        sentBeforeError: true,
        stage: "platform_send",
      });
      return [{ channel: "telegram", messageId: "tg-first" }] as never;
    });

    const params = makeBaseParams({ runStartedAt: 1_000 });
    params.deliveryPayloads = [{ text: "First payload." }, { text: "Second payload." }];
    params.outputText = "Second payload.";
    params.summary = "Second payload.";
    params.deliveryBestEffort = true;
    await dispatchCronDelivery(params);
    expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(1);
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
      sourceSessionKey: "agent:main:cron:test-job",
      cfg: expect.anything(),
      channel: "telegram",
      route: expect.objectContaining({ to: "telegram:123456", from: "telegram:123456" }),
    });
  });

  it("commits the route from the first platform result before a later sub-send failure throws (#112710)", async () => {
    mockResolvedOutboundRoute({ to: "telegram:123456" });
    const deliveryError = new Error("second payload failed");
    let committedBeforeBatchReturned = false;
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (deliveryParams) => {
      await deliveryParams.onDeliveryResult?.({
        channel: "telegram",
        messageId: "tg-first",
      });
      committedBeforeBatchReturned = vi.mocked(ensureOutboundSessionEntry).mock.calls.length > 0;
      deliveryParams.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error: deliveryError,
        sentBeforeError: true,
        stage: "platform_send",
      });
      return [{ channel: "telegram", messageId: "tg-first" }] as never;
    });

    const params = makeBaseParams({ runStartedAt: 1_000 });
    params.deliveryPayloads = [{ text: "First payload." }, { text: "Second payload." }];
    params.outputText = "Second payload.";
    params.summary = "Second payload.";
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryState).toMatchObject({
      status: "not-delivered",
      error: deliveryError.message,
    });
    expect(committedBeforeBatchReturned).toBe(true);
    expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(1);
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
      sourceSessionKey: "agent:main:cron:test-job",
      cfg: expect.anything(),
      channel: "telegram",
      route: expect.objectContaining({ to: "telegram:123456", from: "telegram:123456" }),
    });
  });

  it("no delivery requested means deliveryAttempted stays false and no delivery is sent", async () => {
    const params = makeBaseParams({
      synthesizedText: "Task done.",
      deliveryRequested: false,
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(false);
  });

  it("suppresses control tokens on the direct delivery path", async () => {
    const params = structuredParams([{ text: "ANNOUNCE_SKIP" }], "ANNOUNCE_SKIP");
    const state = await dispatchCronDelivery(params);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
      deliveryAttempted: true,
    });
  });

  it("refuses a current-target completion without its captured source generation", async () => {
    const params = makeBaseParams({
      synthesizedText: "must not attach to a future replacement",
      sessionTarget: "current",
    });
    params.sourceSessionGeneration = undefined;

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({
      delivered: false,
      deliveryAttempted: true,
      deliveryError: "current cron delivery is missing its source session generation",
    });
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("commits a current-target completion on a webchat-only gateway with no configured channels", async () => {
    const params = makeBaseParams({
      synthesizedText: "scheduled dashboard report",
      sessionTarget: "current",
      runStartedAt: 1_000,
    });
    const dashboardSessionKey = "agent:main:dashboard:c5557dcf-54bf-46b0-9bf2-a1f6ad1d0667";
    params.job.sessionKey = dashboardSessionKey;
    params.sourceSessionKey = dashboardSessionKey;
    params.resolvedDelivery = {
      ok: false,
      channel: undefined,
      mode: "implicit",
      error: new Error("No configured channels detected"),
    };

    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    expect(state.deliveryError).toBeUndefined();
    expect(commitBackgroundResultToSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: dashboardSessionKey,
        text: "scheduled dashboard report",
      }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("retains the external route error after committing the current session", async () => {
    const params = makeBaseParams({
      synthesizedText: "Committed report",
      sessionTarget: "current",
      runStartedAt: 1_500,
    });
    params.resolvedDelivery = {
      ok: false,
      channel: "telegram",
      mode: "implicit",
      error: new Error("Target is required"),
    };
    const state = await dispatchCronDelivery(params);
    expect(state.disposition).toBeUndefined();
    expect(state).toMatchObject({
      delivered: false,
      deliveryAttempted: true,
      deliveryError: "Target is required",
    });
    expect(commitBackgroundResultToSessionMock).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("commits a safe media projection and still sends the current-target payload once", async () => {
    const params = makeBaseParams({ sessionTarget: "current", runStartedAt: 2_500 });
    params.synthesizedText = undefined;
    params.summary = undefined;
    params.outputText = undefined;
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [{ mediaUrl: "https://example.com/report.png?token=redacted" }];

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    expect(commitBackgroundResultToSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "report.png",
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ mediaUrl: "https://example.com/report.png?token=redacted" }],
    });
  });

  it("uses the finalized descendant payload set when a final reply supersedes media", async () => {
    vi.mocked(expectsSubagentFollowup).mockReturnValue(true);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue("Final descendant reply");

    const params = makeBaseParams({ sessionTarget: "current", runStartedAt: 3_500 });
    params.synthesizedText = "Example report";
    params.summary = "Example report";
    params.outputText = "Example report";
    params.deliveryPayloads = [
      { text: "Example report", mediaUrl: "/tmp/allowed-media/report.png" },
    ];

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    const commitCall = vi.mocked(commitBackgroundResultToSessionMock).mock.calls.at(-1)?.[0];
    expect(commitCall).toMatchObject({ text: "Final descendant reply" });
    expect(state.deliveryPayloads).toEqual([{ text: "Final descendant reply" }]);
    expectDeliveryCall(0, { payloads: [{ text: "Final descendant reply" }] });
  });

  it("does not mark or send a current-target delivery when its session commit fails", async () => {
    const queueSourceAwareness = vi.fn().mockResolvedValue(undefined);
    commitBackgroundResultToSessionMock.mockResolvedValueOnce({
      ok: false,
      reason: "source session was archived",
    });
    const params = makeBaseParams({
      synthesizedText: "must not escape before commit",
      sessionTarget: "current",
    });
    params.queueSourceSessionMessageToolAwareness = queueSourceAwareness;

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({
      delivered: false,
      deliveryAttempted: true,
      deliveryError: "source session was archived",
    });
    expect(queueSourceAwareness).toHaveBeenCalledOnce();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("keeps same-source awareness unavailable while the durable commit is in flight", async () => {
    const queueSourceAwareness = vi.fn().mockResolvedValue(undefined);
    commitBackgroundResultToSessionMock.mockImplementationOnce(async () => {
      expect(queueSourceAwareness).not.toHaveBeenCalled();
      return { ok: true, messageId: "current-completion-message" };
    });
    const params = makeBaseParams({
      synthesizedText: "message-tool completion",
      sessionTarget: "current",
    });
    params.sourceDeliveryOutcome = messageToolOutcome([
      {
        tool: "message",
        provider: "webchat",
        to: "owner",
        text: "message-tool completion",
      },
    ]);
    params.queueSourceSessionMessageToolAwareness = queueSourceAwareness;

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    expect(commitBackgroundResultToSessionMock).toHaveBeenCalledTimes(1);
    expect(queueSourceAwareness).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("keeps unresolved message-tool delivery out of delivered status", async () => {
    const params = makeBaseParams({ synthesizedText: "hello from cron" });
    params.job.deleteAfterRun = true;
    params.resolvedDelivery = {
      ok: false,
      channel: undefined,
      mode: "implicit",
      error: new Error("sessionKey is required to resolve delivery.channel=last"),
    };
    params.sourceDeliveryOutcome = messageToolOutcome(
      [{ tool: "message", provider: "messagechat", to: "123" }],
      false,
    );

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(state.delivered).toBe(false);
    expect(state).toMatchObject({
      disposition: { kind: "error", errorKind: "delivery-target" },
      deliveryAttempted: false,
    });
    expect(state.disposition).toMatchObject({
      error: expect.stringContaining("sessionKey is required to resolve delivery.channel=last"),
    });
    expect(state.disposition).toMatchObject({
      error: expect.stringContaining(
        "the agent used the message tool, but OpenClaw could not verify",
      ),
    });
  });

  it("does not mirror a direct delivery into a restart tombstone missing archive metadata", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      from: "whatsapp:+15551234567",
      to: "+15551234567",
    });
    loadCronSessionEntryLatestMock.mockReturnValue({
      sessionId: "restart-tombstone-session",
      lifecycleRevision: "failed-generation",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        chargedAttempts: 3,
        tombstone: {
          reason: "automatic recovery exhausted",
          recoveredSessionId: "dashboard-successor",
          recoveredSessionKey: "agent:main:dashboard:successor",
        },
      },
    });

    const params = makeBaseParams({ synthesizedText: "Delivered outside OpenClaw" });
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps successful direct delivery delivered when the transcript mirror append fails", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      from: "whatsapp:+15551234567",
      to: "+15551234567",
    });
    vi.mocked(appendAssistantMessageToSessionTranscript).mockRejectedValueOnce(
      new Error("transcript locked"),
    );

    const params = makeBaseParams({ synthesizedText: "sent despite mirror failure" });
    params.cfgWithAgentDefaults = {
      session: { dmScope: "per-channel-peer" },
    } as never;
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, { completionRetention: directCronCompletionRetention });
  });

  it("keeps custom session cron delivery mirrors on the custom session", async () => {
    const params = makeBaseParams({
      synthesizedText: "custom-session report",
      sessionTarget: "session:daily-report",
    });
    params.agentSessionKey = "agent:main:session:daily-report";
    params.cfgWithAgentDefaults = {
      session: { store: "cron-custom-session-mirror.json" },
    } as never;
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.disposition).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:session:daily-report",
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:session:daily-report",
      agentId: "main",
      expectedSessionId: "test-session-id",
      expectedLifecycleRevision: "test-lifecycle-revision",
      text: "custom-session report",
      mediaUrls: undefined,
      storePath: expect.stringContaining("cron-custom-session-mirror.json"),
      idempotencyKey: expect.stringContaining("test-job"),
      config: params.cfgWithAgentDefaults,
    });
  });

  it.each([
    ["structured silent cleanup", SILENT_REPLY_TOKEN, true, true],
    ["trailing text reply", "Nothing actionable found today.\n\nNO_REPLY", false, false],
  ] as const)("suppresses %s (#64976)", async (_name, text, structured, cleanup) => {
    const params = makeBaseParams({ synthesizedText: text });
    params.deliveryPayloadHasStructuredContent = structured;
    params.job.deleteAfterRun = cleanup;

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
      deliveryAttempted: true,
    });
    if (cleanup) {
      expect(callGateway).toHaveBeenCalledOnce();
    }
  });

  it("delivers a non-trailing NO_REPLY mention with trailing whitespace", async () => {
    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "Use NO_REPLY when nothing actionable changed.\n" }),
    );
    expectDelivered(state);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  describe("real outbound retry outcomes", () => {
    let harness: typeof import("./run.test-harness.js");
    let runCronIsolatedAgentTurn: typeof import("./run.js").runCronIsolatedAgentTurn;
    let realDeliver: typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloadsInternal;

    beforeAll(async () => {
      harness = await import("./run.test-harness.js");
      vi.doUnmock("./helpers.js");
      vi.doUnmock("../../channels/plugins/index.js");
      runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
      realDeliver = (
        await vi.importActual<typeof import("../../infra/outbound/deliver.js")>(
          "../../infra/outbound/deliver.js",
        )
      ).deliverOutboundPayloadsInternal;
    });

    beforeEach(() => {
      harness.resetRunCronIsolatedAgentTurnHarness();
      loadCronSessionEntryLatestMock.mockImplementation(harness.loadSessionEntryMock);
      harness.mockRunCronFallbackPassthrough();
      harness.dispatchCronDeliveryMock.mockImplementation(dispatchCronDelivery);
      harness.resolveCronDeliveryPlanMock.mockImplementation(resolveCronDeliveryPlan);
      harness.resolveDeliveryTargetMock.mockResolvedValue(makeResolvedDelivery());
      vi.mocked(deliverOutboundPayloads).mockImplementation(realDeliver);
      vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    });

    afterEach(() => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createTestRegistry());
      vi.mocked(deliverOutboundPayloads)
        .mockReset()
        .mockResolvedValue([{ ok: true } as never]);
    });

    it.each([
      { name: "best-effort retry", bestEffort: true, partialSend: false },
      { name: "required partial send without retry", bestEffort: false, partialSend: true },
    ])("reports $name from actual adapter outcomes", async ({ bestEffort, partialSend }) => {
      await withTempCronHome(async () => {
        const notDispatched = new PlatformMessageNotDispatchedError(
          "payload stopped before final dispatch",
          { cause: new Error("connect ECONNREFUSED") },
        );
        const receipt = { channel: "telegram", messageId: "cron-retry-message" };
        const sendText = vi.fn();
        if (partialSend) {
          sendText.mockResolvedValueOnce(receipt).mockRejectedValueOnce(notDispatched);
        } else {
          sendText.mockRejectedValueOnce(notDispatched).mockResolvedValueOnce(receipt);
        }
        const registry = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: { deliveryMode: "direct", sendText },
            }),
          },
        ]);
        setActivePluginRegistry(registry);
        harness.preparedRunPluginRegistryMock.mockReturnValue(registry);
        harness.runEmbeddedAgentMock.mockResolvedValue({
          payloads: partialSend
            ? [{ text: "First payload." }, { text: "Second payload." }]
            : [{ text: "Retry me once." }],
          meta: { agentMeta: {} },
        });
        const { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } =
          await import("./job-fixtures.js");
        const result = await runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({
            job: makeIsolatedAgentJobFixture({
              delivery: { mode: "announce", channel: "telegram", to: "123456", bestEffort },
            }),
          }),
        );

        expect(result.error).toBeUndefined();
        expect(sendText).toHaveBeenCalledTimes(2);
        expect(harness.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
        expect(deliverOutboundPayloads).toHaveBeenCalledTimes(partialSend ? 1 : 2);
        expect(result.status).toBe("ok");
        expect(result.deliveryAttempted).toBe(true);
        expect.soft(result.delivered).toBe(!partialSend);
        if (partialSend) {
          expect(result.deliveryError).toContain(notDispatched.message);
        } else {
          expect.soft(result.deliveryError).toBeUndefined();
          const intent = outboundDeliveryCall(0).deliveryIntentId;
          expect(intent).toEqual(expect.stringContaining("cron-direct-delivery:v1:"));
          expectDeliveryCall(1, {
            deliveryIntentId: intent,
            reusePendingDeliveryIntent: true,
            completionRetention: directCronCompletionRetention,
          });
        }
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
