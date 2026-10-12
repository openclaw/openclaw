import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDescendantRunAwaitingSettleFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type * as SessionAccessor from "../../config/sessions/session-accessor.js";
import type * as SessionEntryReadRuntime from "../../config/sessions/session-entry-read-runtime.js";
import * as deliveryQueueSqlite from "../../infra/delivery-queue-sqlite.js";
import { summarizeOutboundPayloadForTransport } from "../../infra/outbound/payloads.js";

const directCronCompletionRetention = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
};

const {
  appendAssistantMessageToSessionTranscriptMock,
  commitBackgroundResultToSessionMock,
  hasUnsettledCronDescendantsMock,
  listDescendantRunsForRequesterMock,
  deliverOutboundPayloadsMock,
  loadCronSessionEntryLatestMock,
  loadSessionEntryReadOnlyMock,
  readSessionEntryInWorkerMock,
  maybeApplyTtsToPayloadMock,
  retireSessionMcpRuntimeMock,
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
  listDescendantRunsForRequesterMock: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsMock: vi.fn().mockResolvedValue([{ ok: true }]),
  loadCronSessionEntryLatestMock: vi.fn(),
  loadSessionEntryReadOnlyMock: vi.fn(),
  readSessionEntryInWorkerMock: vi.fn<typeof SessionEntryReadRuntime.readSessionEntryInWorker>(),
  maybeApplyTtsToPayloadMock: vi.fn(async (params: { payload: unknown }) => params.payload),
  retireSessionMcpRuntimeMock: vi.fn().mockResolvedValue(true),
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

vi.mock("./run-subagent-registry.runtime.js", () => ({
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionAccessor>()),
  loadSessionEntryReadOnly: loadSessionEntryReadOnlyMock,
}));

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionEntryReadRuntime>()),
  readSessionEntryInWorker: readSessionEntryInWorkerMock,
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

vi.mock("./subagent-followup.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./subagent-followup.js")>("./subagent-followup.js");
  return {
    readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
    waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
    waitForDescendantSubagentResult: actual.waitForDescendantSubagentResult,
  };
});

import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { callGateway } from "../../gateway/call.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { makeCfg, withTempCronHome } from "../isolated-agent.test-harness.js";
import type { CronDelivery } from "../types.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import {
  makeBaseParams,
  makeResolvedDelivery,
  messageToolOutcome,
} from "./delivery-dispatch.test-fixtures.js";
import { hasUnsettledCronDescendants } from "./delivery-subagent-registry.runtime.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import * as realFollowup from "./subagent-followup.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.runtime.js";

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

const buttons = { telegram: { buttons: [[{ text: "Open", url: "https://example.test" }]] } };

function structuredParams(
  payloads: Parameters<typeof dispatchCronDelivery>[0]["deliveryPayloads"],
  text: string,
) {
  const params = makeBaseParams({});
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
    deliverOutboundPayloadsMock.mockReset().mockImplementation(async (delivery) => {
      for (const payload of delivery.payloads) {
        delivery.onDeliveredPayload?.(summarizeOutboundPayloadForTransport(payload));
      }
      return [{ channel: "telegram", messageId: "delivered-report" }];
    });
    vi.spyOn(deliveryQueueSqlite, "inspectDeliveryQueueReceipt").mockResolvedValue({
      status: undefined,
      pendingEntry: null,
    });
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(false);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(false);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(retireSessionMcpRuntime).mockResolvedValue(true);
    readSessionEntryInWorkerMock.mockResolvedValue({
      sessionId: "destination-session-id",
      lifecycleRevision: "destination-lifecycle-revision",
      updatedAt: 1,
    });
    loadSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "destination-session-id",
      lifecycleRevision: "destination-lifecycle-revision",
    });
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("does not wait for descendants when a creatorless best-effort target is unresolved", async () => {
    const params = makeBaseParams({ deliveryBestEffort: true, synthesizedText: "Result" });
    params.resolvedDelivery = {
      ok: false,
      mode: "implicit",
      error: new Error("No delivery route"),
    };
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(true);

    const result = await dispatchCronDelivery(params);

    expect(result).toMatchObject({
      disposition: { kind: "suppressed" },
      delivered: false,
      deliveryError: "No delivery route",
    });
    expect(hasUnsettledCronDescendants).not.toHaveBeenCalled();
    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
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
      error: expect.stringContaining("adapter_returned_no_identity"),
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

  it.each([
    {
      name: "textless",
      input: [{ text: "   " }, {}],
      summary: "Pablo Daily Summary\n- One task needs attention.",
      output: [{ text: "Pablo Daily Summary\n- One task needs attention." }],
    },
    {
      name: "metadata-only",
      input: [{ text: "   ", channelData: buttons }],
      summary: "Report ready",
      output: [
        { text: "Report ready" },
        { fallbackText: { text: "Report ready", replacesPayloadIndex: 0 }, channelData: buttons },
      ],
    },
    {
      name: "silent metadata",
      input: [{ text: SILENT_REPLY_TOKEN, channelData: buttons }],
      summary: SILENT_REPLY_TOKEN,
      output: [{ channelData: buttons }],
    },
  ])("normalizes $name direct payloads", async ({ input, summary, output }) => {
    const state = await dispatchCronDelivery(structuredParams(input, summary));
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, { payloads: output });
    expectDelivered(state);
  });

  it.each([true, false])("suppresses stale interim text with bestEffort=%s", async (bestEffort) => {
    vi.mocked(hasUnsettledCronDescendants)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(bestEffort);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({
      synthesizedText: "on it, pulling everything together",
      deliveryBestEffort: bestEffort,
    });
    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(bestEffort ? 0 : 1);
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    if (!bestEffort) {
      expect(state.deliveryError).toBe("cron descendants completed without a final reply");
    }
  });

  it("classifies a settled child's AUTOMATION_FAILED answer and delivers only its explanation", async () => {
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(
      "AUTOMATION_FAILED\nNo shell tool is available in this run.",
    );

    const state = await dispatchCronDelivery(emptyParams(true));

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, { payloads: [{ text: "No shell tool is available in this run." }] });
    expect(state).toMatchObject({
      delivered: true,
      agentReportedFailure: "No shell tool is available in this run.",
      summary: "No shell tool is available in this run.",
    });
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

  describe("spawn-only handoff without delivery", () => {
    const childReply = "[blocked] Unable to execute the command: no shell tool.";
    let runStartedAt = 0;

    beforeEach(() => {
      vi.useFakeTimers();
      // Production wait timings (5 s synthesis grace) under fake time.
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      runStartedAt = Date.now();
      // Announce settlement runs for real too, so a no-delivery run routed through it
      // shows its parent-synthesis wait and dropped silence.
      vi.mocked(waitForDescendantSubagentSummary).mockImplementation(
        realFollowup.waitForDescendantSubagentSummary,
      );
      vi.mocked(readDescendantSubagentFallbackReply).mockImplementation(
        realFollowup.readDescendantSubagentFallbackReply,
      );
    });
    afterEach(() => {
      vi.useRealTimers();
      listDescendantRunsForRequesterMock.mockResolvedValue([]);
    });

    function spawnOnlyJob(delivery: CronDelivery) {
      const params = emptyParams(true);
      params.job.delivery = delivery;
      params.job.deleteAfterRun = true;
      params.deliveryPlan = resolveCronDeliveryPlan(params.job);
      params.deliveryRequested = params.deliveryPlan.requested;
      params.runStartedAt = runStartedAt;
      return params;
    }

    /** The registry settles the child at `settleAfterMs` with the given terminal reply. */
    function childSettlesAt(
      settleAfterMs: number,
      terminalReply: NonNullable<SubagentRunRecord["completion"]>["terminalReply"],
    ) {
      const settledAt = runStartedAt + settleAfterMs;
      vi.mocked(hasUnsettledCronDescendants).mockImplementation(async () => Date.now() < settledAt);
      listDescendantRunsForRequesterMock.mockImplementation(async () =>
        Date.now() < settledAt
          ? []
          : [
              {
                runId: "child-run",
                childSessionKey: "agent:main:subagent:child",
                requesterSessionKey: "agent:main:cron:test-job",
                requesterDisplayKey: "agent:main:cron:test-job",
                task: "monthly report",
                cleanup: "keep",
                createdAt: runStartedAt,
                execution: { status: "terminal", endedAt: settledAt, outcome: { status: "ok" } },
                completion: { required: true, terminalReply },
              } as SubagentRunRecord,
            ],
      );
    }

    async function dispatchUntilWatchdog(params: DispatchCronDeliveryParams) {
      const watchdog = new AbortController();
      setTimeout(() => watchdog.abort(new Error("cron run timed out")), params.timeoutMs);
      params.abortSignal = watchdog.signal;
      params.isAborted = () => watchdog.signal.aborted;
      const state = dispatchCronDelivery(params);
      await vi.advanceTimersByTimeAsync(params.timeoutMs + 1_000);
      return await state;
    }

    it.each(["visible", "silent", "failure"] as const)(
      "records a settled %s child without delivery",
      async (kind) => {
        const params = spawnOnlyJob({ mode: "none" });
        const explanation = "No shell tool is available in this run.";
        childSettlesAt(
          kind === "visible" ? params.timeoutMs - 3_000 : 1_000,
          kind === "silent"
            ? { disposition: "silent" }
            : {
                disposition: "visible",
                text: kind === "failure" ? `AUTOMATION_FAILED\n${explanation}` : childReply,
              },
        );

        const state = await dispatchUntilWatchdog(params);

        expect(deliverOutboundPayloads).not.toHaveBeenCalled();
        if (kind === "silent") {
          expect(state.summary).toBeUndefined();
        } else {
          expect(state).toMatchObject({
            outputText: kind === "failure" ? explanation : childReply,
            summary: kind === "failure" ? explanation : childReply,
            deliveryState: { status: "not-requested" },
          });
        }
        if (kind === "failure") {
          expect(state.agentReportedFailure).toBe(explanation);
          expect(callGateway).not.toHaveBeenCalledWith(
            expect.objectContaining({ method: "sessions.delete" }),
          );
        } else {
          expect(state.disposition).toBeUndefined();
          expectSessionDeleted();
        }
      },
    );

    it.each([
      {
        name: "the child never settles",
        settleAfterMs: Number.POSITIVE_INFINITY,
        error: "cron child-session handoff timed out before producing a final assistant payload",
      },
      {
        name: "the child ends without output",
        settleAfterMs: 1_000,
        error: "cron child-session handoff completed without a final assistant payload",
      },
    ])("fails and keeps the transcript when $name", async ({ settleAfterMs, error }) => {
      const params = spawnOnlyJob({ mode: "none" });
      params.abortSignal = undefined;
      childSettlesAt(settleAfterMs, { disposition: "empty" });

      const pending = dispatchCronDelivery(params);
      await vi.advanceTimersByTimeAsync(params.timeoutMs + 1_000);
      const state = await pending;

      expect(state.disposition).toMatchObject({ kind: "error", error });
      expect(callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );
    });

    it("leaves webhook jobs on their own completion policy", async () => {
      const params = spawnOnlyJob({ mode: "webhook", to: "https://hooks.example.test/cron" });
      childSettlesAt(0, { disposition: "visible", text: childReply });

      const state = await dispatchUntilWatchdog(params);

      expect(state.disposition).toBeUndefined();
      expect(state.summary).toBeUndefined();
      expect(listDescendantRunsForRequesterMock).not.toHaveBeenCalled();
    });
  });

  it("preserves abort precedence when an accepted child handoff is interrupted", async () => {
    const abortReason = "scheduled run aborted while waiting for its child";
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValueOnce(true).mockResolvedValue(false);
    const params = emptyParams(true);
    params.abortSignal = AbortSignal.abort(new Error(abortReason));
    params.isAborted = () => true;
    params.abortReason = () => abortReason;

    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      disposition: { kind: "error", error: abortReason },
    });
    expect(readDescendantSubagentFallbackReply).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps a no-spawn parent silent when deliveryRequested=%s",
    async (requested) => {
      const params = requested
        ? emptyParams()
        : makeBaseParams({
            synthesizedText: "Task done.",
            deliveryRequested: false,
          });

      const state = await dispatchCronDelivery(params);

      expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
      expect(readDescendantSubagentFallbackReply).not.toHaveBeenCalled();
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(state.deliveryAttempted).toBe(false);
    },
  );

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

  it("applies TTS before sending the notification", async () => {
    const speech = {
      text: "",
      spokenText: "Briefing",
      audioAsVoice: true,
      mediaUrl: "file:///tmp/voice.mp3",
      mediaUrls: ["file:///tmp/chart.png", "file:///tmp/narration.ogg"],
    };
    maybeApplyTtsToPayloadMock.mockResolvedValue(speech);
    const params = makeBaseParams({ synthesizedText: "[[tts]] Briefing", runStartedAt: 1_000 });
    params.cfgWithAgentDefaults = { tts: { auto: "tagged", provider: "microsoft" } };
    const state = await dispatchCronDelivery(params);
    expectDelivered(state);
    expect(maybeApplyTtsToPayloadMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payload: { text: "[[tts]] Briefing" },
        cfg: params.cfgWithAgentDefaults,
        channel: "telegram",
        agentId: "main",
      }),
    );
    expectDeliveryCall(0, { payloads: [speech] });
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("strips a silent caption but retains its notification media", async () => {
    const params = makeBaseParams({});
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

  it.each(["late", "scheduled on time", "zero schedule"])(
    "handles a %s cron start",
    async (schedule) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));
      const late = schedule === "late";
      const params = makeBaseParams({
        synthesizedText: late ? "Yesterday's morning briefing." : "Long running report finished.",
      });
      const earlier = Date.now() - (3 * 60 * 60_000 + 1);
      if (late) {
        params.job.deleteAfterRun = true;
        params.beforeSessionDelete = vi.fn();
      } else {
        params.runStartedAt = earlier;
      }
      params.job.state = { nextRunAtMs: schedule === "zero schedule" ? 0 : earlier };
      const state = await dispatchCronDelivery(params);
      if (!late) {
        expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
        expectDelivered(state);
        return;
      }
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
    },
  );

  it.each(["deleted", "retired", "aborted", "survived", "archived"] as const)(
    "preserves run cleanup when its outcome is %s",
    async (outcome) => {
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
      expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
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
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
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
      status: "unknown",
      error:
        "second payload stopped before final dispatch | OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED | connect ECONNREFUSED | ECONNREFUSED",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each(["completed", "live", "stale"] as const)(
    "settles a competing cron delivery whose pending owner is %s",
    async (owner) => {
      vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(
        new Error("Stable delivery intent is already queued"),
      );
      const status = vi
        .mocked(deliveryQueueSqlite.inspectDeliveryQueueReceipt)
        .mockResolvedValueOnce({ status: undefined, pendingEntry: null })
        .mockResolvedValueOnce({
          status: owner === "completed" ? "completed" : "pending",
          pendingEntry:
            owner === "completed"
              ? null
              : {
                  id: "cross-process-cron-intent",
                  enqueuedAt: Date.now() - (owner === "stale" ? 60_000 : 0),
                  retryCount: 0,
                  platformSendStartedAt: Date.now() - (owner === "stale" ? 30_001 : 0),
                  recoveryState: "send_attempt_started",
                },
        });
      if (owner === "live") {
        status.mockResolvedValueOnce({ status: "completed", pendingEntry: null });
      }
      const state = await dispatchCronDelivery(
        makeBaseParams({ synthesizedText: "Cross-process cron update." }),
      );
      expect(state.delivered).toBe(owner !== "stale");
      expect(state.deliveryAttempted).toBe(true);
      expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
      if (owner === "stale") {
        expect(deliveryQueueSqlite.inspectDeliveryQueueReceipt).toHaveBeenCalledTimes(2);
      } else {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
      }
    },
  );

  it.each([true, false])(
    "handles a receipt-store outage with bestEffort=%s",
    async (bestEffort) => {
      vi.mocked(deliveryQueueSqlite.inspectDeliveryQueueReceipt).mockImplementationOnce(() => {
        throw new Error("SQLite receipt store unavailable");
      });
      const pending = dispatchCronDelivery(
        makeBaseParams({
          synthesizedText: "Storage outage update.",
          deliveryBestEffort: bestEffort,
        }),
      );
      if (bestEffort) {
        expectDelivered(await pending);
        expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
        expectDeliveryCall(0, {
          bestEffort: true,
          completionRetention: directCronCompletionRetention,
        });
      } else {
        expect(await pending).toMatchObject({
          delivered: false,
          deliveryError: "SQLite receipt store unavailable",
        });
        expect(deliverOutboundPayloads).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps regenerated signed media URLs on the same durable cron intent", async () => {
    vi.mocked(deliveryQueueSqlite.inspectDeliveryQueueReceipt)
      .mockResolvedValueOnce({ status: undefined, pendingEntry: null })
      .mockResolvedValueOnce({ status: "completed", pendingEntry: null });
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
    const calls = vi.mocked(deliveryQueueSqlite.inspectDeliveryQueueReceipt).mock.calls;
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

  it("reports a failed notification without queuing target-session awareness", async () => {
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

    expect(state.deliveryState).toMatchObject({
      status: "not-delivered",
      error: deliveryError.message,
    });
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not retry a partial notification with bestEffort=%s (#112710)",
    async (bestEffort) => {
      const deliveryError = new Error("second payload failed");
      vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (deliveryParams) => {
        if (!bestEffort) {
          await deliveryParams.onDeliveryResult?.({ channel: "telegram", messageId: "tg-first" });
        }
        deliveryParams.onPayloadDeliveryOutcome?.({
          index: 1,
          status: "failed",
          error: deliveryError,
          sentBeforeError: true,
          stage: "platform_send",
        });
        return [{ channel: "telegram", messageId: "tg-first" }];
      });
      const params = makeBaseParams({ runStartedAt: 1_000, deliveryBestEffort: bestEffort });
      params.deliveryPayloads = [{ text: "First payload." }, { text: "Second payload." }];
      params.outputText = "Second payload.";
      params.summary = "Second payload.";
      const state = await dispatchCronDelivery(params);
      expect(state.deliveryState).toMatchObject({
        status: "unknown",
        error: deliveryError.message,
      });
      expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "refuses a current-target completion with archived=%s",
    async (archived) => {
      const params = makeBaseParams({
        synthesizedText: "must not escape before commit",
        sessionTarget: "current",
      });
      params.resolvedDelivery = {
        ok: false,
        mode: "implicit",
        error: new Error("No configured channels detected"),
      };
      const error = archived
        ? "source session was archived"
        : "current cron delivery is missing its source session binding";
      if (archived) {
        commitBackgroundResultToSessionMock.mockResolvedValueOnce({ ok: false, reason: error });
      } else {
        params.sourceSessionGeneration = undefined;
      }
      const state = await dispatchCronDelivery(params);
      expect(state).toMatchObject({
        delivered: false,
        deliveryAttempted: archived,
        deliveryError: error,
      });
      if (!archived) {
        expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
      }
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "telegram"])(
    "only commits current-session output without an external route (channel=%s)",
    async (channel) => {
      const params = makeBaseParams({
        synthesizedText: channel ? "Committed report" : "scheduled dashboard report",
        sessionTarget: "current",
        runStartedAt: channel ? 1_500 : 1_000,
      });
      const dashboardSessionKey = "agent:main:dashboard:c5557dcf-54bf-46b0-9bf2-a1f6ad1d0667";
      if (!channel) {
        params.job.sessionKey = dashboardSessionKey;
        params.sourceSessionKey = dashboardSessionKey;
      }
      params.resolvedDelivery = {
        ok: false,
        channel,
        mode: "implicit",
        error: new Error(channel ? "Target is required" : "No configured channels detected"),
      };
      const state = await dispatchCronDelivery(params);
      if (!channel) {
        expect(state.disposition).toBeUndefined();
      }
      expect(state).toMatchObject({ delivered: !channel, deliveryAttempted: !channel });
      expect(state.deliveryError).toBe(channel ? "Target is required" : undefined);
      if (channel) {
        expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
      } else {
        expect(commitBackgroundResultToSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: dashboardSessionKey,
            text: "scheduled dashboard report",
          }),
        );
      }
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "hands the finalized current-target media projection to outbound with descendant=%s",
    async (descendant) => {
      const params = makeBaseParams({
        sessionTarget: "current",
        runStartedAt: descendant ? 3_500 : 2_500,
      });
      if (descendant) {
        vi.mocked(expectsSubagentFollowup).mockReturnValue(true);
        vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue("Final descendant reply");
        params.synthesizedText = params.summary = params.outputText = "Example report";
        params.deliveryPayloads = [
          { text: "Example report", mediaUrl: "/tmp/allowed-media/report.png" },
        ];
      } else {
        params.synthesizedText = params.summary = params.outputText = undefined;
        params.deliveryPayloads = [{ mediaUrl: "https://example.com/report.png?token=redacted" }];
      }
      const state = await dispatchCronDelivery(params);
      expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
      expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expectDeliveryCall(0, {
        payloads: descendant
          ? [{ text: "Final descendant reply" }]
          : [{ mediaUrl: "https://example.com/report.png?token=redacted" }],
      });
    },
  );

  it.each(["isolated", "current"])(
    "avoids duplicate %s delivery after a verified message-tool send",
    async (sessionTarget) => {
      const current = sessionTarget === "current";
      const params = makeBaseParams({ synthesizedText: "NO_REPLY", sessionTarget });
      params.sourceSessionKey = "agent:main:dashboard:source";
      params.sourceSessionGeneration = {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
      };
      params.sourceDeliveryOutcome = messageToolOutcome([
        current
          ? {
              tool: "message",
              provider: "webchat",
              to: "owner",
              text: "message-tool completion",
            }
          : {
              tool: "message",
              provider: "telegram",
              to: "123456",
              text: "message-tool completion",
            },
      ]);
      const state = await dispatchCronDelivery(params);
      expectDelivered(state);
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    ["control token", "ANNOUNCE_SKIP", true, false, true, false],
    ["structured silent cleanup", SILENT_REPLY_TOKEN, true, true, false, false],
    [
      "trailing text reply",
      "Nothing actionable found today.\n\nNO_REPLY",
      false,
      false,
      false,
      false,
    ],
    [
      "non-trailing mention",
      "Use NO_REPLY when nothing actionable changed.\n",
      false,
      false,
      false,
      true,
    ],
  ] as const)(
    "normalizes %s delivery (#64976)",
    async (_name, text, structured, cleanup, direct, delivered) => {
      const params = direct
        ? structuredParams([{ text }], text)
        : makeBaseParams({ synthesizedText: text });
      params.job.deleteAfterRun = cleanup;
      const state = await dispatchCronDelivery(params);
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(delivered ? 1 : 0);
      if (delivered) {
        expectDelivered(state);
      } else {
        expect(state).toMatchObject({
          disposition: { kind: "suppressed" },
          delivered: false,
          deliveryAttempted: true,
        });
      }
      if (cleanup) {
        expect(callGateway).toHaveBeenCalledOnce();
      }
    },
  );

  describe("real outbound retry outcomes", () => {
    let harness: typeof import("./run.test-harness.js");
    let runCronIsolatedAgentTurn: typeof import("./run.js").runCronIsolatedAgentTurn;
    let realDeliver: typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloadsInternal;
    let realLoadSessionEntryReadOnly: typeof SessionAccessor.loadSessionEntryReadOnly;
    let realReadSessionEntryInWorker: typeof SessionEntryReadRuntime.readSessionEntryInWorker;

    beforeAll(async () => {
      harness = await import("./run.test-harness.js");
      vi.doUnmock("./helpers.js");
      vi.doUnmock("../../channels/plugins/index.js");
      runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
      // Load the facade's lazy executor once for the adapter-outcome fixture.
      await import("./run-executor.runtime.js");
      realDeliver = (
        await vi.importActual<typeof import("../../infra/outbound/deliver.js")>(
          "../../infra/outbound/deliver.js",
        )
      ).deliverOutboundPayloadsInternal;
      realLoadSessionEntryReadOnly = (
        await vi.importActual<typeof SessionAccessor>("../../config/sessions/session-accessor.js")
      ).loadSessionEntryReadOnly;
      realReadSessionEntryInWorker = (
        await vi.importActual<typeof SessionEntryReadRuntime>(
          "../../config/sessions/session-entry-read-runtime.js",
        )
      ).readSessionEntryInWorker;
    });

    beforeEach(() => {
      harness.resetRunCronIsolatedAgentTurnHarness();
      loadCronSessionEntryLatestMock.mockImplementation(harness.loadSessionEntryMock);
      harness.mockRunCronFallbackPassthrough();
      harness.dispatchCronDeliveryMock.mockImplementation(dispatchCronDelivery);
      harness.resolveCronDeliveryPlanMock.mockImplementation(resolveCronDeliveryPlan);
      harness.resolveDeliveryTargetMock.mockImplementation(resolveDeliveryTarget);
      loadSessionEntryReadOnlyMock.mockImplementation(realLoadSessionEntryReadOnly);
      readSessionEntryInWorkerMock.mockImplementation(realReadSessionEntryInWorker);
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

    it.each(["none", "text", "all"] as const)(
      "preserves channel fallback and suppression at the adapter boundary with veto=%s",
      async (veto) => {
        await withTempCronHome(async () => {
          const sent: ReplyPayload[] = [];
          const sendText = vi.fn(async ({ text }: { text: string }) => {
            sent.push({ text });
            return { channel: "telegram", messageId: "transformed-message" };
          });
          const sendPayload = vi.fn(async ({ payload }: { payload: ReplyPayload }) => {
            sent.push(payload);
            return { channel: "telegram", messageId: "structured-message" };
          });
          const channelData =
            veto === "text"
              ? { telegram: { reaction: { emoji: "👍", replyToId: "123" } } }
              : buttons;
          const registry = createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createOutboundTestPlugin({
                  id: "telegram",
                  outbound: { deliveryMode: "direct", sendText, sendPayload },
                }),
                messaging: {
                  transformReplyPayload: ({ payload }: { payload: ReplyPayload }) =>
                    veto === "all" || (veto === "text" && payload.text)
                      ? null
                      : {
                          ...payload,
                          ...(payload.text ? { text: payload.text + "!" } : {}),
                          ...(payload.fallbackText
                            ? {
                                fallbackText: {
                                  ...payload.fallbackText,
                                  text: payload.fallbackText.text + "!",
                                },
                              }
                            : {}),
                        },
                },
              },
            },
          ]);
          setActivePluginRegistry(registry);
          const state = await dispatchCronDelivery(
            structuredParams([{ text: "Report" }, { channelData }], "Report"),
          );
          expect(state.delivered).toBe(veto !== "all");
          expect(sent).toHaveLength(veto === "all" ? 0 : veto === "text" ? 1 : 2);
          if (veto === "none") {
            expect(sent).toContainEqual(expect.objectContaining({ text: "Report!" }));
          }
          if (veto !== "all") {
            expect(sent).toContainEqual(expect.objectContaining({ channelData }));
          }
        });
      },
    );

    it.for([
      { name: "best-effort retry", bestEffort: true, partialSend: false },
      { name: "required partial send without retry", bestEffort: false, partialSend: true },
    ])(
      "reports $name from actual adapter outcomes",
      async ({ bestEffort, partialSend }, { signal }) => {
        await withTempCronHome(async (home) => {
          const storePath = path.join(home, "agents", "main", "sessions", "sessions.json");
          harness.resolveCronSessionMock.mockReturnValue(harness.makeCronSession({ storePath }));
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
              cfg: makeCfg(home, storePath),
              agentId: "main",
              abortSignal: signal,
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
          expect.soft(result.delivered).toBe(partialSend ? undefined : true);
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
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
