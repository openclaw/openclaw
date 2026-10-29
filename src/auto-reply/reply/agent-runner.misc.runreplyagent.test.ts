import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { modelDefinition, providerConfig } from "../../agents/model-auth.fixtures.test-support.js";
import {
  beginForegroundSessionMaintenance,
  waitForSessionMaintenance,
} from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { createUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { NormalizedUsage } from "../../agents/usage.js";
import { setRuntimeConfigSnapshot, type OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { peekSystemEvents } from "../../infra/system-events.js";
import {
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { GatewayDrainingError } from "../../process/command-queue.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import type { VisibleWorkSession } from "../get-reply-options.types.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import {
  compactState,
  loadCronStoreMock,
  rootDir,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  runtimeErrorMock,
  setupAgentRunnerTestHooks,
  tempDirs,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { type BaseRunOptions, createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { clearPendingFinalDeliveryAfterSuccess } from "./dispatch-from-config.pending-final.js";
import { scheduleFollowupDrain } from "./queue.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

type RunWithModelFallbackParams = TestModelFallbackRunnerParams;

const requireRecord = createRequireRecord("record", "expected-label-object");

function sessionFixture(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: Date.now(), ...overrides };
}

function sessionState(sessionKey: string, sessionEntry: SessionEntry) {
  return { sessionKey, sessionEntry, sessionStore: { [sessionKey]: sessionEntry } };
}

async function storedSession(
  overrides: Partial<SessionEntry> = {},
  sessionKey = "main",
  tmp = tempDirs.make("openclaw-reply-"),
) {
  const storePath = path.join(tmp, "sessions.json");
  const sessionEntry = sessionFixture(overrides);
  await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
  return {
    tmp,
    storePath,
    sessionKey,
    sessionEntry,
    scope: { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
    reply: { ...sessionState(sessionKey, sessionEntry), storePath },
  };
}

function agentRun(options: BaseRunOptions = {}) {
  return createBaseRun({
    ...options,
    run: { agentId: "main", agentDir: path.join(rootDir, "agent"), ...options.run },
  });
}

function assistantMessage(input: number, output: number, text = "NO_REPLY") {
  return makeAssistantMessageFixture({
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-opus-4-6",
    content: [{ type: "text", text }],
    stopReason: "stop",
    errorMessage: undefined,
    usage: createUsageFixture(input, output, input + output),
  });
}

function flushPlan(overrides: { softThresholdTokens?: number; systemPrompt?: string } = {}) {
  return {
    softThresholdTokens: 4_000,
    reserveTokensFloor: 20_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    prompt: "Pre-compaction memory flush.",
    systemPrompt: "Write durable memory, then reply NO_REPLY.",
    relativePath: "memory/active.md",
    ...overrides,
  };
}

function channelRun(provider: string, to: string, options: BaseRunOptions = {}) {
  return createBaseRun({
    ...options,
    context: {
      Provider: provider,
      OriginatingTo: to,
      AccountId: "primary",
      MessageSid: "msg",
      ...options.context,
    },
    run: { messageProvider: provider, thinkLevel: "low", ...options.run },
  });
}

function replyResult<T extends Record<string, unknown>>(text: string, meta: T) {
  return { payloads: [{ text }], meta };
}

function replyText(result: Awaited<ReturnType<typeof runReplyAgent>>) {
  return (Array.isArray(result) ? result : [result])
    .map((payload) => payload?.text ?? "")
    .join("\n");
}

function expectReplyText(result: unknown, text: string): void {
  expect(requireRecord(result, "reply result")).toMatchObject({ text });
}

// Hoist mocks before static dependencies, but defer the runner to avoid incomplete cyclic exports.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
const { runReplyAgent } = await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

it("refuses an unbound question without falling through to active-run queueing", async () => {
  const gatewayCall = vi.fn(async () => ({ status: "answered" }));
  const reservation = registerPendingAgentQuestion({
    questionId: "ask_direct_cli_answer",
    sessionKey: "main",
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Green" }],
      },
    ],
    gatewayCall,
    answer: Promise.resolve({ status: "pending" }),
  });
  reservation.attachRegistration(Promise.resolve({ id: "ask_direct_cli_answer" }));
  const replyOperationRunState = {};
  const testRun = createBaseRun({
    context: { agentText: "Green" },
    followup: { transcriptPrompt: "Green" },
    reply: {
      commandBody: "Green",
      transcriptCommandBody: "Green",
      sessionKey: "main",
      isActive: true,
      shouldSteer: true,
      opts: { [REPLY_OPERATION_RUN_STATE]: replyOperationRunState },
    },
  });

  try {
    await expect(testRun.run()).resolves.toEqual({
      text: expect.stringContaining("pending question has no prepared creator authority"),
      isError: true,
    });
    expect(gatewayCall).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(testRun.typing.cleanup).toHaveBeenCalledOnce();
  } finally {
    reservation.dispose();
  }
});

describe("runReplyAgent auto-compaction token update", () => {
  it("keeps an unarmed preflight drain visible instead of dropping the reply", async () => {
    const { reply } = await storedSession(
      {
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1 as const,
      },
      "agent:main:main",
    );
    compactState.compactEmbeddedAgentSessionMock.mockRejectedValueOnce(new GatewayDrainingError());

    const result = await agentRun({ run: { reasoningLevel: "on" }, reply }).run();

    expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expectReplyText(result, "⚠️ Gateway is restarting. Please wait a few seconds and try again.");
    expect(result).toMatchObject({ isError: true });
  });

  it.each([
    { preempted: false, retiredGateway: false },
    { preempted: true, retiredGateway: false },
    { preempted: false, retiredGateway: true },
    { preempted: false, retiredGateway: false, compactAfterFlush: true },
  ])(
    "defers optional memory until real delivery settles ($preempted, retired=$retiredGateway, compact=$compactAfterFlush)",
    async ({ preempted, retiredGateway, compactAfterFlush = false }) => {
      const tmp = tempDirs.make("openclaw-early-flush-");
      const storePath = path.join(tmp, "sessions.json");
      const sessionKey = "agent:main:main";
      const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
      const sessionEntry = sessionFixture({
        totalTokens: 10_920,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        compactionCount: 0,
      });
      const reply = { ...sessionState(sessionKey, sessionEntry), storePath };
      const prompt = "What is two plus two? Answer in one short sentence without tools.";
      const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => boolean>(() => true);
      const delivery = createDeferred();
      const requestBudget = {
        contextWindow: 32_768,
        reserveTokens: 8_192,
        fixedTokens: 9_500,
        pendingTokens: 512,
        pendingUserIdempotencyKey: "processed-user",
      };
      let memoryParams: RunEmbeddedAgentInternalParams | undefined;
      let memoryScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
      let gatewayActive = true;
      const gatewayContext = {
        terminalSessions: {},
        resolveGatewayContext: () => (gatewayActive ? gatewayContext : undefined),
      } as never;
      const resolveGatewayContext = () => gatewayContext;
      let releaseForeground: (() => void) | undefined;
      const config = providerConfig("anthropic", {
        baseUrl: "https://example.test",
        models: [
          modelDefinition("claude-opus-4-6", {
            name: "Test model",
            contextTokens: 32_768,
            reasoning: false,
          }),
        ],
      });
      registerMemoryFlushPlanResolverForTest(({ cfg, contextWindowTokens }) => {
        expect(cfg?.models?.providers?.anthropic?.models).toMatchObject([
          { id: "claude-opus-4-6", contextTokens: 32_768 },
        ]);
        expect(contextWindowTokens).toBe(32_768);
        return flushPlan();
      });
      // The usage counters are from bounded QA metadata. This assembled prompt and
      // transcript are synthetic; their estimates are not an observed second-turn budget.
      runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.config?.models?.providers?.anthropic?.models).toEqual(
          config.models?.providers?.anthropic?.models,
        );
        if (params.trigger === "memory") {
          memoryParams = params;
          memoryScope = getPluginRuntimeGatewayRequestScope();
          const privateTranscript = expectDefined(params.sessionManager, "memory transcript");
          expect(privateTranscript.getSessionTarget()).toBeUndefined();
          privateTranscript.appendMessage(assistantMessage(7_039, 34));
          return {
            payloads: [],
            meta: { agentMeta: { lastCallUsage: { input: 7_039, output: 34 } } },
          };
        }
        expect(params.prompt).toContain(prompt);
        params.onSuccessfulAuthProfile?.(undefined);
        params.onCompactionRequestBudget?.(requestBudget);
        return replyResult("Two plus two is four.", {
          agentMeta: {
            sessionId: "session",
            agentHarnessId: "openclaw",
            provider: "anthropic",
            model: "claude-opus-4-6",
            lastCallUsage: { input: compactAfterFlush ? 26_000 : 10_920, output: 10 },
          },
        });
      });
      try {
        // Memory-flush persistence reads runtime config again; share its authoritative source
        // with the queued turn so the selected model cannot escape into real catalog discovery.
        setRuntimeConfigSnapshot(config, config);
        await replaceSessionEntry(scope, sessionEntry);
        SessionManager.open(scope, tmp).appendMessage(assistantMessage(10_920, 10));
        const turn = agentRun({
          followup: { prompt },
          run: {
            agentDir: path.join(tmp, "agent"),
            sessionKey,
            sessionFile: path.join(tmp, "session.jsonl"),
            workspaceDir: tmp,
            model: "claude-opus-4-6",
            config,
            timeoutMs: 600_000,
            senderIsOwner: true,
          },
          reply: {
            commandBody: prompt,
            ...reply,
            opts: { onReplyOperationOwned },
          },
        });
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            resolveGatewayContext,
            nodePlacementGrantAuthority: {
              agentId: "main",
              sessionKey,
              runId: "foreground",
              assertCurrent: () => {},
            },
          },
          turn.run,
        );
        const operation = expectDefined(
          onReplyOperationOwned.mock.calls[0]?.[0],
          "admitted reply operation",
        );

        expect(compactState.compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
        expect(runtimeErrorMock).not.toHaveBeenCalled();
        expect(runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger)).toEqual(["user"]);
        expectReplyText(result, "Two plus two is four.");
        expect(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        operation.completeWithAfterClearBarrier(delivery.promise, 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger)).toEqual(["user"]);
        // Foreground priority has cleared, but maintenance still waits for actual delivery.
        let maintenanceSettled = false;
        const maintenance = waitForSessionMaintenance(sessionKey).then(() => {
          maintenanceSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(maintenanceSettled).toBe(false);
        if (preempted) {
          releaseForeground = await beginForegroundSessionMaintenance(sessionKey);
        }
        vi.useRealTimers();
        const completion = getReplyPayloadMetadata(
          expectDefined(Array.isArray(result) ? result[0] : result, "delivered reply"),
        )?.pendingFinalDeliveryCompletion;
        expect(completion).toBeDefined();
        await settlePendingFinalDelivery({ kind: "pending-final", ...completion! }, "delivered");
        await clearPendingFinalDeliveryAfterSuccess(completion);
        gatewayActive = !retiredGateway;
        delivery.resolve();
        await operation.ownerSettlement;
        await maintenance;
        expect(runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger)).toEqual(
          preempted || retiredGateway ? ["user"] : ["user", "memory"],
        );
        if (preempted || retiredGateway) {
          expect(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        } else {
          expect(memoryParams?.senderIsOwner).toBe(false);
          expect(memoryScope?.nodePlacementGrantAuthority).toBeUndefined();
          expect(memoryScope?.resolveGatewayContext?.()).toBe(gatewayContext);
          expect(loadSessionEntry(scope)?.memoryFlush).toMatchObject({
            kind: "succeeded",
            compactionCount: 0,
          });
          if (compactAfterFlush) {
            expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledWith(
              expect.objectContaining({ trigger: "budget" }),
              expect.objectContaining({ requestBudget: { ...requestBudget, pendingTokens: 0 } }),
            );
          }
        }
      } finally {
        vi.useRealTimers();
        delivery.resolve();
        onReplyOperationOwned.mock.calls[0]?.[0].complete();
        releaseForeground?.();
        await waitForSessionMaintenance(sessionKey);
      }
    },
  );

  it("loads post-compaction context before starting a queued followup drain", async () => {
    const workspaceDir = tempDirs.make("openclaw-post-compaction-queued-followup-");
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "## Session Startup\nRead the queued workspace startup file.\n\n## Red Lines\nNever skip startup context after compaction.\n",
      "utf-8",
    );
    const sessionKey = "main";
    const sessionEntry = sessionFixture({ totalTokens: 50_000 });
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return replyResult("ok", { agentMeta: {} });
    });

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      const events = peekSystemEvents(resolveSystemEventQueueKey(key, "main"));
      expect(events).toHaveLength(1);
      expect(events[0]).toContain("Read the queued workspace startup file.");
      expect(events[0]).toContain("Never skip startup context after compaction.");
    });

    await agentRun({
      run: {
        workspaceDir,
        reasoningLevel: "on",
        config: {
          agents: {
            defaults: { compaction: { postCompactionSections: ["Session Startup", "Red Lines"] } },
          },
        },
      },
      reply: { ...sessionState(sessionKey, sessionEntry) },
    }).run();

    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });

  it("keeps a provided reply operation active until final delivery completes", async () => {
    const sessionKey = "main";
    const sessionEntry = sessionFixture({ totalTokens: 50_000 });
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: sessionEntry.sessionId,
      resetTriggered: false,
    });
    const deliveryOrder: string[] = [];
    runEmbeddedAgentMock.mockResolvedValue(replyResult("ok", { agentMeta: {} }));

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      deliveryOrder.push("followup");
    });

    const result = await agentRun({
      run: { reasoningLevel: "on" },
      reply: { queueKey: sessionKey, ...sessionState(sessionKey, sessionEntry), replyOperation },
    }).run();

    expectReplyText(result, "ok");
    expect(getSessionControllerOperation(sessionKey)).toBe(replyOperation);
    expect(replyOperation.result).toBeNull();
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    deliveryOrder.push("final");
    replyOperation.complete();

    expect(deliveryOrder).toEqual(["final", "followup"]);
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, "aborted_by_user"],
    [true, "aborted_for_supersession"],
  ] as const)(
    "records a settled fallback cancellation (superseded=%s) without losing committed compaction",
    async (superseded, expectedCode) => {
      const upstreamAbort = new AbortController();
      const { storePath, sessionKey, sessionEntry, reply } = await storedSession(
        {
          sessionId: "session-upstream-cancelled",
          lifecycleRevision: "original-generation",
          compactionCount: 3,
          totalTokens: 50_000,
        },
        `${superseded ? "superseded" : "upstream-cancelled"}-settled-fallback`,
      );
      const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => boolean>(() => true);
      const candidateSettled = createDeferred();
      const fallbackRelease = createDeferred();
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          params.onCompactionAccounting?.({
            kind: "durable",
            count: 1,
            currentContextSnapshot: { tokens: 40 },
            target: {
              agentId: "main",
              sessionId: sessionEntry.sessionId,
              sessionKey,
              storePath,
              lifecycleRevision: sessionEntry.lifecycleRevision,
              activeWriterRunId: undefined,
            },
          });
          return replyResult("late reply", {
            agentMeta: { compactionCount: 1, compactionTokensAfter: 40 },
          });
        },
      );
      runWithModelFallbackMock.mockImplementationOnce(
        async (params: RunWithModelFallbackParams) => {
          const result = await runInitialModelFallbackAttempt(params);
          candidateSettled.resolve();
          await fallbackRelease.promise;
          return { result, provider: params.provider, model: params.model, attempts: [] };
        },
      );
      const baseRun = agentRun({
        run: {
          sessionId: sessionEntry.sessionId,
          sessionKey,
          reasoningLevel: "on",
        },
        reply: {
          ...reply,
          opts: { abortSignal: upstreamAbort.signal, onReplyOperationOwned },
        },
      });

      try {
        const pending = baseRun.run();
        await awaitGateBeforeSettlement(
          candidateSettled.promise,
          pending,
          "Reply settled before the fallback candidate completed",
        );
        const replyOperation = expectDefined(
          onReplyOperationOwned.mock.calls[0]?.[0],
          "admitted reply operation",
        );
        if (superseded) {
          replyOperation.supersede();
        } else {
          upstreamAbort.abort(new Error("caller cancelled"));
        }
        fallbackRelease.resolve();

        expect(await pending).toEqual({});
        expect(replyOperation.result).toEqual({ kind: "aborted", code: expectedCode });
        expect(
          loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId: sessionEntry.sessionId,
          lifecycleRevision: "original-generation",
          compactionCount: 4,
          totalTokens: 40,
          totalTokensFresh: true,
        });
        expect(peekSystemEvents(resolveSystemEventQueueKey(sessionKey, "main"))).toEqual([]);
      } finally {
        fallbackRelease.resolve();
        onReplyOperationOwned.mock.calls[0]?.[0].complete();
      }
    },
  );
});

describe("runReplyAgent block streaming", () => {
  function runBlockStreaming(opts: NonNullable<Parameters<typeof runReplyAgent>[0]["opts"]>) {
    return channelRun("discord", "channel:C1", {
      run: {
        config: {
          agents: {
            defaults: { blockStreamingCoalesce: { minChars: 1, maxChars: 200, idleMs: 0 } },
          },
        },
        reasoningLevel: "on",
        blockReplyBreak: "text_end",
      },
      reply: {
        opts,
        blockStreamingEnabled: true,
        blockReplyChunking: { minChars: 1, maxChars: 200, breakPreference: "paragraph" },
        resolvedBlockStreamingBreak: "text_end",
      },
    }).run();
  }

  it("returns the final payload when onBlockReply times out", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const blockReplyStarted = createDeferred();

    const onBlockReply = vi.fn((_payload, context) => {
      return new Promise<void>((resolve) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
        blockReplyStarted.resolve();
      });
    });

    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Chunk" });
      return replyResult("Final message", {});
    });

    const resultPromise = runBlockStreaming({ onBlockReply, blockReplyTimeoutMs: 1 });

    await blockReplyStarted.promise;
    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expectReplyText(result, "Final message");
  });
});

it("delivers tool progress with inline on over stored full", async () => {
  const override = "on";
  const { storePath, sessionKey, reply } = await storedSession({ verboseLevel: "full" });
  const onToolResult = vi.fn(async (_payload: ReplyPayload) => {});
  const onRunVerbosityResolved = vi.fn();
  runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
    expect(onRunVerbosityResolved).toHaveBeenCalledExactlyOnceWith({
      verboseLevelOverride: override,
      resolvedVerboseLevel: override,
    });
    if (params.shouldEmitToolResult?.()) {
      await params.onToolResult?.({ text: "Tool summary" });
    }
    if (params.shouldEmitToolOutput?.()) {
      await params.onToolResult?.({ text: "Tool output" });
    }
    return replyResult("Done", {});
  });
  const result = await createBaseRun({
    run: { sessionKey, verboseLevel: override, verboseLevelOverride: override },
    reply: {
      ...reply,
      resolvedVerboseLevel: override,
      opts: { onToolResult, onRunVerbosityResolved },
    },
  }).run();
  expect(onToolResult.mock.calls.map(([payload]) => payload.text)).toEqual(["Tool summary"]);
  expect(loadSessionEntry({ storePath, sessionKey })?.verboseLevel).toBe("full");
  expectReplyText(result, "Done");
});

describe("runReplyAgent Active Memory inline debug", () => {
  it.each([
    ["off", "on", undefined, true],
    ["on", "off", undefined, false],
    ["off", "on", "off", false],
    ["on", "off", "on", true],
  ] as const)(
    "refreshes authorized plugin trace %s → %s with override %s (visible=%s)",
    async (stored, live, override, visible) => {
      const { storePath, sessionEntry, reply } = await storedSession({ traceLevel: stored });
      runEmbeddedAgentMock.mockImplementationOnce(async () => {
        await replaceSessionEntry(
          { storePath, sessionKey: "main" },
          {
            ...sessionEntry,
            traceLevel: live,
            pluginDebugEntries: [
              { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: trace"] },
            ],
          },
        );
        return replyResult("Normal reply", {});
      });
      const result = await createBaseRun({
        run: { traceAuthorized: true, traceLevelOverride: override },
        reply,
      }).run();
      expect(replyText(result).includes("Active Memory Debug")).toBe(visible);
      expect(replyText(result)).not.toContain("Model Input (User Role)");
      expect(loadSessionEntry({ storePath, sessionKey: "main" })?.traceLevel).toBe(live);
    },
  );

  it("appends raw trace payloads with escaped fences when trace raw is enabled", async () => {
    const { tmp, storePath, sessionKey, sessionEntry, scope, reply } = await storedSession({
      traceLevel: "raw",
      compactionCount: 3,
    });
    const transcript = await SessionManager.openAsync(scope, tmp);
    await transcript.appendMessageAsync({ role: "user", content: "Earlier turn", timestamp: 0 });
    await transcript.appendMessageAsync(
      makeAssistantMessageFixture({
        content: [{ type: "text", text: "Earlier reply" }],
        stopReason: "stop",
        errorMessage: undefined,
        usage: {
          ...createUsageFixture(200, 10, 235),
          cacheRead: 20,
          cacheWrite: 5,
        },
      }),
    );

    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => ({
      result: await runFallbackModelAttempt(params, "anthropic", "claude", "timeout"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "LLM request timed out.",
          reason: "timeout",
          status: 408,
        },
      ],
    }));
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      params.onCompactionAccounting?.({
        kind: "durable",
        count: 1,
        currentContextSnapshot: { tokens: 1250 },
        target: {
          agentId: "main",
          sessionId: sessionEntry.sessionId,
          sessionKey,
          storePath,
          lifecycleRevision: sessionEntry.lifecycleRevision,
          activeWriterRunId: undefined,
        },
      });
      return replyResult("Visible reply", {
        finalPromptText:
          "Context:\n<active_memory_plugin>\nPrefer from/to failover logs.\n</active_memory_plugin>\n\n/trace raw show me everything\n~~~\nnot a fence",
        finalAssistantVisibleText: "Visible reply",
        finalAssistantRawText: "<final>Visible reply\n~~~\nresponse</final>",
        executionTrace: {
          winnerProvider: "anthropic",
          winnerModel: "claude",
          runner: "embedded",
          fallbackUsed: false,
          attempts: [
            {
              provider: "anthropic",
              model: "claude",
              result: "success",
              stage: "assistant",
              elapsedMs: 4200,
            },
          ],
        },
        toolSummary: {
          calls: 2,
          tools: ["active-memory", "github-search"],
          failures: 0,
          totalToolTimeMs: 481,
        },
        completion: { finishReason: "stop", stopReason: "end_turn", refusal: false },
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          usage: { input: 1200, output: 45, cacheRead: 800, cacheWrite: 200, total: 2245 },
          lastCallUsage: {
            input: 1000,
            output: 45,
            cacheRead: 750,
            cacheWrite: 150,
            total: 1945,
          },
          promptTokens: 1250,
          compactionCount: 1,
        },
      });
    });

    const result = await channelRun("telegram", "chat:1", {
      context: { CommandBody: "/trace raw show me everything" },
      run: {
        agentId: "main",
        sessionKey,
        sessionFile: sessionKey,
        reasoningLevel: "on",
        thinkLevel: "low",
        traceAuthorized: true,
      },
      reply,
    }).run();

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[])[0]?.text).toBe("Visible reply");
    const traceText = (result as { text?: string }[])[1]?.text ?? "";
    expect(traceText).toContain("🔎 Usage (Session Total):");
    expect(traceText).toContain("🔎 Usage (Last Turn Total):");
    expect(traceText).toContain("used=1,250 tok (1.3k)");
    expect(traceText).toContain("winner=anthropic/claude");
    expect(traceText).toContain("fallbackUsed=yes");
    expect(traceText).toContain("attempts=2");
    expect(traceText).toContain("1. openai/gpt-5.5");
    expect(traceText).toContain("result=timeout");
    expect(traceText).toContain("status=408");
    expect(traceText).toContain("2. anthropic/claude");
    expect(traceText).toContain("result=success");
    expect(traceText).toContain("thinking=low");
    expect(traceText).toContain("reasoning=on");
    expect(traceText).toContain("active_memory_plugin=");
    expect(traceText).toContain("user_message=");
    expect(traceText).toContain("tools=active-memory, github-search");
    expect(traceText).toContain("finishReason=stop");
    expect(traceText).toContain("stopReason=end_turn");
    expect(traceText).toContain("refusal=no");
    expect(traceText).toContain("sessionCompactions=4");
    expect(traceText).toContain("lastTurnCompactions=1");
    expect(traceText).toContain("🔎 Model Input (User Role):");
    expect(traceText).toContain("🔎 Model Output (Assistant Role):");
    expect(traceText).toContain("Summary: winner=claude 🧠 low fallback=yes attempts=2");
    expect(traceText).not.toContain("🔎 Provider Usage (Turn Total):");
    expect(traceText).not.toContain("🔎 Provider Usage (Last Provider Call):");
    expect(traceText).toContain("show me everything\n\\~~~\nnot a fence");
    expect(traceText).toContain("<final>Visible reply\n\\~~~\nresponse</final>");
  });
});

it("does not leak hook-blocked CLI input in raw trace payloads", async () => {
  const blocked =
    "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)";
  const secret = "secret hitl prompt";
  runCliAgentMock.mockResolvedValueOnce({
    payloads: [{ text: blocked, isError: true }],
    meta: {
      error: { kind: "hook_block", message: blocked },
      agentMeta: { provider: "claude-cli", model: "opus-4.5" },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus-4.5",
        attempts: [
          {
            provider: "claude-cli",
            model: "opus-4.5",
            result: "error",
            reason: "before_agent_run blocked the run",
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
    },
  });

  const sessionEntry = sessionFixture({ traceLevel: "raw" });
  const result = await channelRun("webchat", "session:1", {
    context: {
      CommandBody: secret,
      RawBody: secret,
      BodyForAgent: secret,
      Body: secret,
    },
    followup: { prompt: secret, summaryLine: secret },
    run: {
      agentId: "main",
      traceAuthorized: true,
      provider: "claude-cli",
      model: "opus-4.5",
    },
    reply: {
      commandBody: secret,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      defaultModel: "claude-cli/opus-4.5",
    },
  }).run();

  const texts = replyText(result);
  expect(texts).toContain(blocked);
  expect(texts).toContain("Summary: fallback=no attempts=1");
  expect(texts).toContain("Model Input (User Role):\n~~~text\n<empty>\n~~~");
  expect(texts).toContain("Model Output (Assistant Role):\n~~~text\n<empty>\n~~~");
  expect(texts).not.toContain("winner=");
  expect(texts).not.toContain(secret);
});

describe("runReplyAgent messaging tool dedupe", () => {
  it.each([
    { state: undefined, routed: true, delivered: true },
    { state: "missing", routed: true, delivered: false },
    { state: undefined, routed: false, delivered: false },
  ] as const)(
    "requires current-source evidence before suppressing a deduplicated final: $state/$routed",
    async ({ state, routed, delivered }) => {
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "hello world!" }],
        sourceReplyDeliveryState: state,
        messagingToolSentTexts: ["hello world!"],
        messagingToolSentTargets: routed
          ? [{ tool: "slack", provider: "slack", to: "channel:C1" }]
          : undefined,
        meta: {},
      });
      const result = await channelRun("slack", "channel:C1").run();
      if (delivered) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({ isError: true, text: expect.any(String) });
      }
    },
  );
});

it.each([
  ["unrelated cron jobs", "I'll remind you tomorrow morning.", false],
  ["a failed cron store read", "I'll remind you after lunch.", true],
] as const)("appends a guard note with %s", async (_label, text, readFailed) => {
  if (readFailed) {
    loadCronStoreMock.mockRejectedValueOnce(new Error("store read failed"));
  } else {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "unrelated-job",
          name: "daily-news",
          enabled: true,
          sessionKey: "other-session",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });
  }
  runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text }],
    meta: {},
    successfulCronAdds: 0,
  });
  const result = await channelRun("telegram", "chat", { context: { Surface: "telegram" } }).run();
  expectReplyText(
    result,
    text +
      "\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
  );
});

it.each([false, true])("enforces fallback <final> tags (memory flush=%s)", async (memoryFlush) => {
  const provider = memoryFlush ? "google-gemini-cli" : "google";
  const model = memoryFlush ? "gemini-3" : "gemini-2.5-pro";
  const fallback = async (params: RunWithModelFallbackParams) => ({
    result: await runFallbackModelAttempt(params, provider, model, "unknown"),
    provider,
    model,
    attempts: [],
  });
  let options: BaseRunOptions = {};
  if (memoryFlush) {
    const root = await fs.realpath(tempDirs.make("openclaw-memory-flush-tags-"));
    const { sessionKey, reply } = await storedSession(
      { totalTokens: 1_000_000, totalTokensFresh: true, totalTokensVersion: 1, compactionCount: 0 },
      "agent:main:memory-flush-tags",
      root,
    );
    registerMemoryFlushPlanResolverForTest(() =>
      flushPlan({
        softThresholdTokens: 1_000,
        systemPrompt: "Flush memory into the configured memory file.",
      }),
    );
    runEmbeddedAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runCliAgentMock.mockResolvedValueOnce(replyResult("ok", {}));
    runWithModelFallbackMock.mockImplementation(fallback);
    compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensAfter: 1_000_000 },
    });
    options = {
      run: {
        agentDir: path.join(root, "agent"),
        sessionKey,
        workspaceDir: root,
      },
      reply,
    };
  } else {
    runEmbeddedAgentMock.mockResolvedValueOnce(replyResult("ok", {}));
    runWithModelFallbackMock.mockImplementationOnce(fallback);
  }
  const result = await agentRun(options).run();
  const params = memoryFlush
    ? runEmbeddedAgentMock.mock.calls.find(([call]) =>
        call?.prompt?.includes("Pre-compaction memory flush."),
      )?.[0]
    : runEmbeddedAgentMock.mock.calls[0]?.[0];
  expect(params?.enforceFinalTag).toBe(true);
  if (memoryFlush) {
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  }
  expect(
    (Array.isArray(result) ? result : [result]).filter((payload) => payload?.text === "ok"),
  ).toHaveLength(1);
});

describe("runReplyAgent response usage footer", () => {
  async function usageFooter(
    responseUsage: "tokens" | "full",
    usage: NormalizedUsage | undefined,
    bedrock = true,
    text = "ok",
  ) {
    const provider = bedrock ? "amazon-bedrock" : "anthropic";
    const model = bedrock ? "us.anthropic.claude-sonnet-4-6" : "claude";
    runEmbeddedAgentMock.mockResolvedValueOnce(
      replyResult(text, { agentMeta: { provider, model, usage } }),
    );
    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const result = await createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionKey,
        provider,
        model,
        thinkLevel: "low",
        config: providerConfig(provider, {
          baseUrl: "https://example.test",
          ...(bedrock ? { auth: "aws-sdk" as const } : {}),
          models: [
            modelDefinition(model, {
              reasoning: false,
              cost: bedrock
                ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
                : { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
            }),
          ],
        }),
      },
      reply: { queueKey: sessionKey, sessionKey, sessionEntry: sessionFixture({ responseUsage }) },
    }).run();
    return (Array.isArray(result) ? result[0] : result)?.text ?? "";
  }

  it("omits aggregate-only token totals in the built-in full footer", async () => {
    const text = await usageFooter("full", { total: 1250 }, false);
    expect(text).toContain("anthropic🤖claude");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("💰");
    expect(text).not.toContain("Usage:");
  });

  it("shows configured costs for aws-sdk providers when responseUsage=full", async () => {
    const text = await usageFooter("full", {
      input: 1_000,
      output: 2_000,
      cacheRead: 500,
      cacheWrite: 2_000,
    });
    expect(text).toContain("amazon-bedrock🤖us.anthropic.claude-sonnet-4-6🌘🐌");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("🗄");
    expect(text).toContain("💰0.0406");
    expect(text).not.toContain("Usage:");
    expect(text).not.toContain("· session ");
  });
});

describe("runReplyAgent provider failures", () => {
  function createRun(defaultModel?: string) {
    return createBaseRun({
      context: { Provider: "telegram", MessageSid: "msg" },
      run: { messageProvider: "telegram", config: {}, thinkLevel: "low" },
      reply: defaultModel ? { defaultModel } : {},
    }).run();
  }

  it.each([
    {
      name: "transient HTTP",
      error:
        '521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>',
      expected: "The AI service is having trouble",
      defaultModel: undefined,
    },
    {
      name: "billing with overflow wording",
      error: "402 Payment Required: request token limit exceeded for this billing plan",
      expected: "billing problem",
      defaultModel: "anthropic/claude",
    },
  ])("classifies $name without a reply-layer retry", async ({ error, expected, defaultModel }) => {
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error(error));
    const result = await createRun(defaultModel);
    const payload = Array.isArray(result) ? result[0] : result;
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(payload?.text).toContain(expected);
    if (defaultModel) {
      expect(payload?.text).not.toContain("Context overflow");
    }
  });

  it.each([false, true])("handles retry-limit output (mediaOnly=%s)", async (mediaOnly) => {
    const mediaUrl = "https://example.test/image.png";
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [mediaOnly ? { mediaUrl } : { text: "reasoning", isReasoning: true }],
      meta: {
        error: { kind: "retry_limit", message: "429 Too Many Requests: rate limit exceeded" },
      },
    });
    const result = await createRun("anthropic/claude");
    const payload = Array.isArray(result) ? result[0] : result;
    if (mediaOnly) {
      expect(requireRecord(payload, "media-only retry-limit payload")).toMatchObject({ mediaUrl });
      expect(payload?.text).toBeUndefined();
    } else {
      expect(payload?.text).toContain("The AI service needs a short break");
    }
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

it.each(["completed", "failed", "hidden"] as const)(
  "reports accepted visible work before final dispatch for a %s run",
  async (outcome) => {
    const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
    const { createReplyDispatcher } = await import("./reply-dispatcher.js");
    const order: string[] = [];
    const visibleWork: VisibleWorkSession[][] = [];
    const visible = {
      runId: "visible-run",
      childSessionKey: "agent:main:dashboard:visible-work",
      sessionUrl: "https://openclaw.example/chat/main/visible-work",
      label: "Review",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Finished", ...(outcome === "failed" ? { isError: true } : {}) }],
      acceptedSessionSpawns: [
        { runId: "hidden-run", childSessionKey: "agent:main:subagent:hidden" },
        ...(outcome === "hidden" ? [] : [visible, { ...visible, runId: "duplicate-run" }]),
      ],
      meta: outcome === "failed" ? { error: { kind: "unknown", message: "Run failed" } } : {},
    });
    const storePath = path.join(rootDir, "sessions.sqlite");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: rootDir } },
      session: { store: storePath },
      plugins: { enabled: false },
    };
    const sessionEntry = sessionFixture();
    await replaceSessionEntry({ storePath, sessionKey: "agent:main:main" }, sessionEntry);
    const ctx = buildTestCtx({
      Body: "Start visible work",
      SessionKey: "agent:main:main",
      MessageSid: `visible-work-${outcome}`,
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (_payload, info) => {
        order.push(info.kind);
      },
    });
    try {
      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          onVisibleWorkSessions: (sessions) => {
            visibleWork.push([...sessions]);
            order.push("visible-work");
          },
        },
        replyResolver: async (_ctx, opts) =>
          createBaseRun({
            context: ctx,
            run: { config: cfg, sessionKey: ctx.SessionKey },
            reply: {
              opts,
              replyOperation: opts?.replyOperation,
              queueKey: ctx.SessionKey,
              sessionKey: ctx.SessionKey,
              storePath,
              sessionEntry,
              sessionStore: { "agent:main:main": sessionEntry },
            },
          }).run(),
      });
    } finally {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }

    expect(visibleWork).toEqual(
      outcome === "hidden"
        ? []
        : [[{ sessionKey: visible.childSessionKey, url: visible.sessionUrl, label: "Review" }]],
    );
    expect(order).toEqual(outcome === "hidden" ? ["final"] : ["visible-work", "final"]);
  },
);
