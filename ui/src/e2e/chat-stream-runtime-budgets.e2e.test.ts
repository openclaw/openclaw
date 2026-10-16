import { appendFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import type { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  evaluateControlUiContext,
  getControlUiContextHandle,
} from "../test-helpers/control-ui-e2e-context.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft, waitForCommittedState } from "./settle.test-support.ts";

// Structural render budgets are machine-independent; time/heap ceilings allow
// loaded runners while catching quadratic work and retained stream buffers.
const suite = createChatFlowE2eSuite();

type ChatFlowSuite = ReturnType<typeof createChatFlowE2eSuite>;
type ChatFlowPage = Parameters<Parameters<ChatFlowSuite["withPage"]>[1]>[0]["page"];

const BURST_DELTA_COUNT = 240;
// Observe the path, but reject a direct invalidation for every delta.
const MIN_BURST_INVALIDATIONS = 2;
const MAX_BURST_INVALIDATIONS = 180;
// Allow rare poll-controller updates outside animation frames.
const FRAME_SCHEDULED_MIN_RATIO = 0.9;
const MAX_STEADY_COMPOSER_INVALIDATIONS = 1;

// Shipped live-tool ceiling: ui/src/pages/chat/tool-stream.ts TOOL_STREAM_LIMIT.
const TOOL_STREAM_LIMIT_CONTRACT = 50;
const TOOL_FLOOD_PAIR_COUNT = 60;
// Span the 80ms projection throttle before the result's forced flush.
const TOOL_FLOOD_PHASE_INTERVAL_MS = 30;
// Stay above startup's accepted sequence fence.
const TOOL_FLOOD_SEQ_SEED = 1_000_000;

const LONG_TRANSCRIPT_MESSAGE_COUNT = 400;
const LONG_TRANSCRIPT_LOAD_CEILING_MS = 30_000;
const RICH_TURN_CHUNK_COUNT = 150;
const STREAM_SESSION_HEAP_CEILING_BYTES = 96 * 1024 * 1024;

const IDLE_WINDOW_MS = 4_000;
const IDLE_LONGTASK_TOTAL_CEILING_MS = 600;
const IDLE_TASK_DURATION_CEILING_MS = 600;

type StreamPerfProbe = {
  mutationBatches: number;
  rafCount: number;
  invalidations: number;
  commits: number;
  invalidationsInsideFrame: number;
  offFrameUpdates: Array<{
    host: "page" | "pane";
    rafCount: number;
    phase: "burst" | "settling";
    callers: string[];
  }>;
  droppedOffFrameUpdates: number;
};

type ToolProjectionProbe = {
  beforeThrottleCardCount: number | null;
  afterThrottleCardCount: number | null;
  afterThrottleText: string | null;
  ready: boolean;
};

type ScopedWindow = Window & {
  ocEmitChat: (text: string) => void;
  ocEmitAgent: (seq: number, stream: "tool" | "item", data: unknown) => void;
  openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  ocStreamPerf?: StreamPerfProbe;
  ocIdleProbe?: { longTasks: number; longTaskMs: number };
  ocBurstDone?: boolean;
  ocToolProjectionProbe?: ToolProjectionProbe;
  openclawControlUiE2eGateway?: {
    emit: (event: string, payload?: unknown) => void;
  };
};

let metricsArtifactDir: string;
beforeEach(() => {
  metricsArtifactDir = createControlUiE2eArtifactDir("stream-runtime-budgets");
});

async function recordBudgetMetrics(
  testName: string,
  metrics: Record<string, number>,
): Promise<void> {
  await appendFile(
    path.join(metricsArtifactDir, "metrics.jsonl"),
    `${JSON.stringify({ testName, metrics, recordedAt: new Date().toISOString() })}\n`,
  );
}

// Rendered transcripts strip markdown markers, so visibility polls match the
// plain-text projection of the burst chunk emitted in-page
// (`delta N with **boldN** and \`codeN\` tail`).
function renderedChunkText(index: number): string {
  return `delta ${index} with bold${index} and code${index} tail`;
}

async function installRenderProbe(page: ChatFlowPage) {
  await page.evaluate(async () => {
    const scope = window as ScopedWindow;
    const chatPage = document.querySelector("openclaw-chat-page");
    if (!chatPage) {
      throw new Error("openclaw-chat-page is not mounted");
    }
    scope.ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      invalidations: 0,
      commits: 0,
      invalidationsInsideFrame: 0,
      offFrameUpdates: [],
      droppedOffFrameUpdates: 0,
    };
    new MutationObserver((records) => {
      if (records.length > 0) {
        scope.ocStreamPerf!.mutationBatches += 1;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    let insideFrame = false;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      originalRequestAnimationFrame((time) => {
        scope.ocStreamPerf!.rafCount += 1;
        const previous = insideFrame;
        insideFrame = true;
        try {
          callback(time);
        } finally {
          insideFrame = previous;
        }
      });
    const chunkNames = [
      "control-ui-boot-chat",
      "control-ui-boot-shared",
      "control-ui-boot-new",
      "control-ui-core",
      "control-ui-foundation",
      "index",
    ];
    const sourceNames = new Set([
      "chat-state-render",
      "chat-state-controller",
      "chat-state-events",
      "chat-state-refresh",
      "chat-pane-context",
      "chat-pane-state-owner",
      "create-chat-pane",
      "chat-page",
      "chat-page-retained-sessions",
      "subscriptions-controller",
    ]);
    const classifyCaller = (frame: string): string => {
      const location = frame.match(/\/([^/\s?#]+)\.(js|ts)(?:\?[^\s]*)?:(\d{1,7}):(\d{1,7})\)?$/);
      const name = location?.[1] ?? "";
      const knownChunk = chunkNames.some(
        (prefix) =>
          name.startsWith(`${prefix}-`) &&
          /^[A-Za-z0-9_-]{1,64}$/.test(name.slice(prefix.length + 1)),
      );
      return location && (knownChunk || sourceNames.has(name))
        ? `${name}.${location[2]}:${location[3]}:${location[4]}`
        : "unknown";
    };
    scope.openclawRenderLifecycleTestHook = (host, phase) => {
      const nativeCommit = host instanceof HTMLElement;
      const element: unknown = nativeCommit ? host : Reflect.get(host, "element");
      if (
        !(element instanceof HTMLElement) ||
        (element.localName !== "openclaw-chat-page" && element.localName !== "openclaw-chat-pane")
      ) {
        return;
      }
      const probe = scope.ocStreamPerf!;
      if (phase === "commit") {
        if (nativeCommit) {
          probe.commits += 1;
        }
        return;
      }
      // State admission happens in the runtime; its Solid consumer invalidates later.
      if (nativeCommit) {
        return;
      }
      probe.invalidations += 1;
      if (insideFrame) {
        probe.invalidationsInsideFrame += 1;
      } else if (probe.offFrameUpdates.length < 12) {
        // Keep only known source/asset basenames and coordinates, never raw stacks or values.
        const stack = new Error().stack ?? "";
        probe.offFrameUpdates.push({
          host: element.localName === "openclaw-chat-page" ? "page" : "pane",
          rafCount: probe.rafCount,
          phase: scope.ocBurstDone === true ? "settling" : "burst",
          callers: stack.slice(0, 4096).split("\n").slice(2, 8).map(classifyCaller),
        });
      } else {
        probe.droppedOffFrameUpdates += 1;
      }
    };
    // Frames queued before instrumentation run without the wrapper. Drain them
    // before callers reset the counters and begin the measured interaction.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function resetRenderProbe(page: ChatFlowPage) {
  await page.evaluate(() => {
    const scope = window as ScopedWindow;
    scope.ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      invalidations: 0,
      commits: 0,
      invalidationsInsideFrame: 0,
      offFrameUpdates: [],
      droppedOffFrameUpdates: 0,
    };
  });
}

async function readRenderProbe(page: ChatFlowPage): Promise<StreamPerfProbe> {
  return page.evaluate(() => (window as ScopedWindow).ocStreamPerf!);
}

// Socket-like message tasks avoid nested timers' 4ms clamp, which can spread a
// burst across enough frames to falsely exhaust the budget. Split at a real
// frame so the sanity floor observes two streaming batches.
async function emitDeltaBurstInPage(page: ChatFlowPage, count: number): Promise<void> {
  await page.evaluate((targetCount) => {
    const scope = window as ScopedWindow;
    scope.ocBurstDone = false;
    let emitted = 0;
    const channel = new MessageChannel();
    const postNext = () => channel.port2.postMessage(null);
    const emitNext = () => {
      emitted += 1;
      scope.ocEmitChat(` delta ${emitted} with **bold${emitted}** and \`code${emitted}\` tail`);
      if (emitted === targetCount) {
        channel.port1.close();
        channel.port2.close();
        scope.ocBurstDone = true;
      } else if (emitted === Math.floor(targetCount / 2)) {
        requestAnimationFrame(postNext);
      } else {
        postNext();
      }
    };
    channel.port1.addEventListener("message", emitNext);
    channel.port1.start();
    postNext();
  }, count);
  await page.waitForFunction(() => (window as ScopedWindow).ocBurstDone === true, undefined, {
    timeout: 30_000,
    polling: 50,
  });
}

async function openStreamingTurn(
  page: ChatFlowPage,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  prompt: string,
): Promise<string> {
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const sendRequest = await gateway.waitForRequest("chat.send");
  const params = requireRecord(sendRequest.params);
  const runId = requireString(params.idempotencyKey, "chat send idempotency key");
  await page.evaluate((targetRunId) => {
    const scope = window as ScopedWindow;
    const emit = scope.openclawControlUiE2eGateway?.emit;
    if (!emit) {
      throw new Error("mock gateway handle missing");
    }
    scope.ocEmitChat = (text) =>
      emit("chat", {
        deltaText: text,
        message: { content: [{ text, type: "text" }], role: "assistant", timestamp: Date.now() },
        runId: targetRunId,
        sessionKey: "main",
        state: "delta",
      });
    scope.ocEmitAgent = (seq, stream, data) =>
      emit("agent", {
        data,
        runId: targetRunId,
        seq,
        sessionKey: "main",
        stream,
        ts: Date.now(),
      });
  }, runId);
  // Enter streaming state before resetting measurement counters.
  await gateway.emitGatewayEvent("chat", {
    deltaText: " warmup",
    message: {
      content: [{ text: " warmup", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    },
    runId,
    sessionKey: "main",
    state: "delta",
  });
  await page.locator(".chat-bubble.streaming").getByText("warmup").waitFor();
  return runId;
}

function toolFloodActivity(index: number, phase: "start" | "result") {
  return projectAgentToolActivity({
    toolCallId: `call-${index}`,
    name: "edit",
    phase,
    args: { path: `src/file-${index}.ts` },
    ...(phase === "result" ? { isError: false } : {}),
  });
}

async function probeDeferredToolProjection(page: ChatFlowPage): Promise<void> {
  await page.evaluate(
    ({ seqSeed, activity }) => {
      const scope = window as ScopedWindow;
      const probe: ToolProjectionProbe = {
        beforeThrottleCardCount: null,
        afterThrottleCardCount: null,
        afterThrottleText: null,
        ready: false,
      };
      scope.ocToolProjectionProbe = probe;
      let seq = seqSeed;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) =>
        scope.ocEmitAgent(++seq, "tool", { name: "edit", phase, toolCallId: "call-1", ...data });
      const cardSelector = '[data-message-id^="tool:assistant:call-1:"]';
      scope.ocEmitChat(" working on step 1");
      scope.ocEmitAgent(++seq, "item", activity);
      emitToolPhase("start", { args: { path: "src/file-1.ts" } });
      setTimeout(() => emitToolPhase("update", { partialResult: "partial output 1" }), 10);
      setTimeout(() => emitToolPhase("input_delta", { diff: { added: 1, removed: 1 } }), 20);
      // Sample before the 80ms owner timer. An eager non-terminal projection
      // makes the card visible here and fails the absence contract.
      setTimeout(() => {
        probe.beforeThrottleCardCount = document.querySelectorAll(cardSelector).length;
      }, 50);
      // Leave result un-emitted. After the owner timer and two render frames,
      // the running card must expose the latest update/input_delta projection.
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const cards = document.querySelectorAll(cardSelector);
            probe.afterThrottleCardCount = cards.length;
            probe.afterThrottleText = cards[0]?.textContent ?? null;
            probe.ready = true;
          });
        });
      }, 120);
    },
    { seqSeed: TOOL_FLOOD_SEQ_SEED, activity: toolFloodActivity(1, "start") },
  );
  await page.waitForFunction(
    () => (window as ScopedWindow).ocToolProjectionProbe?.ready === true,
    undefined,
    { timeout: 10_000, polling: 20 },
  );
}

async function completeFirstToolLifecycle(page: ChatFlowPage): Promise<void> {
  await page.evaluate(
    ({ seq, activity }) => {
      const scope = window as ScopedWindow;
      scope.ocEmitAgent(seq, "tool", {
        name: "edit",
        phase: "result",
        result: "tool output 1",
        toolCallId: "call-1",
      });
      scope.ocEmitAgent(seq + 1, "item", activity);
    },
    { seq: TOOL_FLOOD_SEQ_SEED + 5, activity: toolFloodActivity(1, "result") },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function emitRemainingToolLifecycleFlood(
  page: ChatFlowPage,
  pairCount: number,
): Promise<void> {
  // Gateway frames arrive as separate socket messages. Space each lifecycle
  // phase across timer ticks so the live stream exercises deferred projection,
  // not only the result path's forced flush.
  await page.evaluate(
    ({ pairCount: targetPairCount, phaseIntervalMs, seqSeed, activities }) => {
      const scope = window as ScopedWindow;
      scope.ocBurstDone = false;
      let emitted = 1;
      let seq = seqSeed + 6;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) =>
        scope.ocEmitAgent(++seq, "tool", {
          name: "edit",
          phase,
          toolCallId: `call-${emitted}`,
          ...data,
        });
      const emitCall = () => {
        emitted += 1;
        scope.ocEmitChat(` working on step ${emitted}`);
        scope.ocEmitAgent(++seq, "item", activities[emitted - 2]!.start);
        emitToolPhase("start", { args: { path: `src/file-${emitted}.ts` } });
        setTimeout(() => {
          emitToolPhase("update", { partialResult: `partial output ${emitted}` });
          setTimeout(() => {
            emitToolPhase("input_delta", { diff: { added: emitted, removed: 1 } });
            setTimeout(() => {
              emitToolPhase("result", { result: `tool output ${emitted}` });
              scope.ocEmitAgent(++seq, "item", activities[emitted - 2]!.result);
              if (emitted < targetPairCount) {
                setTimeout(emitCall, phaseIntervalMs);
              } else {
                scope.ocBurstDone = true;
              }
            }, phaseIntervalMs);
          }, phaseIntervalMs);
        }, phaseIntervalMs);
      };
      setTimeout(emitCall, phaseIntervalMs);
    },
    {
      pairCount,
      phaseIntervalMs: TOOL_FLOOD_PHASE_INTERVAL_MS,
      seqSeed: TOOL_FLOOD_SEQ_SEED,
      activities: Array.from({ length: pairCount - 1 }, (_, index) => ({
        start: toolFloodActivity(index + 2, "start"),
        result: toolFloodActivity(index + 2, "result"),
      })),
    },
  );
  await page.waitForFunction(() => (window as ScopedWindow).ocBurstDone === true, undefined, {
    timeout: 60_000,
    polling: 200,
  });
}

function buildLongTranscriptFixture(messageCount: number): Array<Record<string, unknown>> {
  return Array.from({ length: messageCount }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const sentinel = index === messageCount - 1 ? " LONG-TAIL-SENTINEL" : "";
    const text =
      role === "user"
        ? `history question ${index}: ${"detail ".repeat(12)}`
        : `history answer ${index}: ${"context ".repeat(16)}${sentinel}`;
    return {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now() - (messageCount - index) * 1_000,
    };
  });
}

suite.define(() => {
  it("commits a streamed delta burst in frame-bound transcript batches", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { deferredMethods: ["sessions.describe"] });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await openStreamingTurn(page, gateway, "burst coalescing probe");

      // Release the startup fact read after Send so it observes the running turn,
      // then join its publication before measuring stream invalidations.
      await gateway.waitForRequest("sessions.describe");
      await gateway.resolveDeferred("sessions.describe");
      const applicationHandle = await getControlUiContextHandle(page);
      try {
        await waitForCommittedState(
          page,
          ({ application, sessionKey }) =>
            application.sessions.state.result?.sessions.some(
              (row) =>
                row.key === sessionKey && row.status === "running" && row.hasActiveRun === true,
            ) === true,
          { application: applicationHandle, sessionKey: "agent:main:main" },
        );
      } finally {
        await applicationHandle.dispose();
      }

      // The delayed swarm child query publishes roster metadata after first paint.
      // Observe its committed result before measuring stream-driven invalidations.
      const childList = await gateway.waitForRequest("sessions.list", {
        match: { spawnedBy: "agent:main:main" },
      });
      const childScope = requireRecord(childList.params);
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (application, scope) => {
              const snapshot = application.sessions.listSnapshot(scope);
              return Boolean(snapshot?.result && !snapshot.loading && !snapshot.error);
            },
            childScope,
          ),
        )
        .toBe(true);
      await waitForChatScrollIdle(page);
      await installRenderProbe(page);
      await resetRenderProbe(page);

      await emitDeltaBurstInPage(page, BURST_DELTA_COUNT);
      await expect
        .poll(() =>
          page.evaluate(
            (finalChunk) =>
              (document.querySelector(".chat-thread-inner")?.textContent ?? "").includes(
                finalChunk,
              ),
            renderedChunkText(BURST_DELTA_COUNT),
          ),
        )
        .toBe(true);
      // Sample after the trailing animation frame drained so the batch count
      // reflects the whole burst, not a mid-render snapshot.
      await expect
        .poll(async () => {
          const before = await readRenderProbe(page);
          await new Promise((resolve) => {
            setTimeout(resolve, 200);
          });
          const after = await readRenderProbe(page);
          return before.mutationBatches === after.mutationBatches ? after : null;
        })
        .not.toBeNull();

      const probe = await readRenderProbe(page);
      await recordBudgetMetrics("delta-burst-commits", {
        mutationBatches: probe.mutationBatches,
        rafCount: probe.rafCount,
        invalidations: probe.invalidations,
        commits: probe.commits,
        invalidationsInsideFrame: probe.invalidationsInsideFrame,
      });

      expect(probe.commits).toBeGreaterThan(0);
      expect(probe.invalidations).toBeGreaterThanOrEqual(MIN_BURST_INVALIDATIONS);
      expect(probe.invalidations).toBeLessThanOrEqual(MAX_BURST_INVALIDATIONS);
      expect(
        probe.invalidationsInsideFrame / probe.invalidations,
        `frame-scheduled update budget: ${JSON.stringify(probe)}`,
      ).toBeGreaterThanOrEqual(FRAME_SCHEDULED_MIN_RATIO);
    });
  });

  it("keeps the live tool stream bounded under complete tool lifecycles", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await openStreamingTurn(page, gateway, "tool flood probe");

      await probeDeferredToolProjection(page);
      const projection = await page.evaluate(() => (window as ScopedWindow).ocToolProjectionProbe!);
      expect(projection.beforeThrottleCardCount).toBe(0);
      expect(projection.afterThrottleCardCount).toBe(1);
      expect(projection.afterThrottleText).toContain("Editing");
      expect(projection.afterThrottleText).toContain("+1");
      expect(projection.afterThrottleText).toContain("-1");

      await completeFirstToolLifecycle(page);
      const firstCard = page.locator('[data-message-id^="tool:assistant:call-1:"]');
      expect(await firstCard.count()).toBe(1);
      expect(await firstCard.textContent()).toContain("Edited");

      await emitRemainingToolLifecycleFlood(page, TOOL_FLOOD_PAIR_COUNT);
      // Uninterrupted narration no longer separates tool cards. Expand the
      // real grouped activity before counting its retained invocation rows.
      const firstRetainedCall = TOOL_FLOOD_PAIR_COUNT - TOOL_STREAM_LIMIT_CONTRACT + 1;
      // The live disclosure shows a purpose headline; count its retained rows below.
      const activity = page.locator(".chat-activity-group > .chat-activity-group__summary");
      await activity.waitFor();
      await activity.click();
      const floodCards = page.locator('[data-message-id^="tool:assistant:call-"]');
      // Eviction drops the oldest entries and keeps the freshest ones.
      await expect
        .poll(() => floodCards.count(), { timeout: 15_000 })
        .toBe(TOOL_STREAM_LIMIT_CONTRACT);
      expect(await page.locator('[data-message-id^="tool:assistant:call-1:"]').count()).toBe(0);
      expect(
        await page
          .locator(`[data-message-id^="tool:assistant:call-${firstRetainedCall}:"]`)
          .count(),
      ).toBe(1);
      expect(
        await page
          .locator(`[data-message-id^="tool:assistant:call-${TOOL_FLOOD_PAIR_COUNT}:"]`)
          .count(),
      ).toBe(1);
    });
  });

  it("loads a long transcript and streams a rich turn inside budget ceilings", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: buildLongTranscriptFixture(LONG_TRANSCRIPT_MESSAGE_COUNT),
      });

      const loadStartedAt = Date.now();
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page
        .locator(".chat-thread-inner")
        .getByText("LONG-TAIL-SENTINEL")
        .waitFor({ timeout: LONG_TRANSCRIPT_LOAD_CEILING_MS });
      const loadMs = Date.now() - loadStartedAt;
      expect(loadMs).toBeLessThanOrEqual(LONG_TRANSCRIPT_LOAD_CEILING_MS);

      const runId = await openStreamingTurn(page, gateway, "rich streaming turn");
      await emitDeltaBurstInPage(page, RICH_TURN_CHUNK_COUNT);
      await gateway.emitChatFinal({ runId, text: "rich turn finalized" });
      await page.locator(".chat-thread-inner").getByText("rich turn finalized").waitFor();

      const cdpSession = await context.newCDPSession(page);
      // Metric collection requires the domain to be enabled first.
      await cdpSession.send("Performance.enable");
      await cdpSession.send("HeapProfiler.collectGarbage");
      await cdpSession.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdpSession.send("Performance.getMetrics");
      const heapUsedBytes = metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value;
      expect(heapUsedBytes).toBeLessThanOrEqual(STREAM_SESSION_HEAP_CEILING_BYTES);

      await recordBudgetMetrics("long-transcript-rich-turn", {
        loadMs,
        heapUsedBytes: Math.round(heapUsedBytes),
      });
    });
  });

  it.each([
    {
      name: "keeps steady-state composer edits local to a long transcript",
      scrollAwayAndBack: false,
    },
    {
      name: "keeps composer edits local after scrolling returns to the same offset",
      scrollAwayAndBack: true,
    },
  ])("$name", async ({ scrollAwayAndBack }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: buildLongTranscriptFixture(LONG_TRANSCRIPT_MESSAGE_COUNT),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-thread-inner").getByText("LONG-TAIL-SENTINEL").waitFor();

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const scopeKey = "chat:v3:agent:main:main\u0000agent:main";
      await composer.fill("seed");
      await page.getByRole("button", { name: "Send message" }).waitFor();
      // The first saved draft notifies presence subscribers. Drain that transition
      // before measuring edits to an already-present draft.
      await waitForCommittedComposerDraft(page, scopeKey, "seed", 0);
      const scrollDuringWait = scrollAwayAndBack
        ? page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate(async (element) => {
            const thread = element as HTMLElement;
            const originalTop = thread.scrollTop;
            // Move during the stability sample, then restore its original geometry.
            await new Promise<void>((resolve) => {
              globalThis.setTimeout(resolve, 100);
            });
            thread.scrollTo({ top: originalTop - 8, behavior: "instant" });
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            const awayTop = thread.scrollTop;
            thread.scrollTo({ top: originalTop, behavior: "instant" });
            return { originalTop, awayTop, restoredTop: thread.scrollTop };
          })
        : Promise.resolve(null);
      // Finish startup scrolling before measuring steady-state composer invalidations.
      await waitForChatScrollIdle(page);
      const scroll = await scrollDuringWait;
      if (scroll) {
        expect(scroll.awayTop).toBeLessThan(scroll.originalTop);
        expect(scroll.restoredTop).toBe(scroll.originalTop);
      }
      await installRenderProbe(page);
      await resetRenderProbe(page);

      const suffix = " ordinary typing without commands";
      await composer.pressSequentially(suffix, { delay: scrollAwayAndBack ? 5 : 0 });
      await waitForCommittedComposerDraft(page, scopeKey, `seed${suffix}`, 0);
      expect(await composer.inputValue()).toBe(`seed${suffix}`);
      const probe = await readRenderProbe(page);

      await recordBudgetMetrics(
        scrollAwayAndBack ? "composer-after-scroll" : "composer-steady-state",
        { invalidations: probe.invalidations, commits: probe.commits },
      );
      expect(probe.invalidations).toBeLessThanOrEqual(MAX_STEADY_COMPOSER_INVALIDATIONS);

      const send = page.locator(".chat-send-btn--send");
      await composer.fill("");
      await expect.poll(() => send.isDisabled()).toBe(true);

      await composer.fill("new draft");
      await expect.poll(() => send.isDisabled()).toBe(false);

      await composer.fill("مرحبا");
      await expect.poll(() => composer.getAttribute("dir")).toBe("rtl");
    });
  });

  it("stays quiet while idle after a settled stream", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const runId = await openStreamingTurn(page, gateway, "idle quiescence probe");
      await gateway.emitChatFinal({ runId, text: "short finalized turn" });
      await page.locator(".chat-thread-inner").getByText("short finalized turn").waitFor();

      const cdpSession = await context.newCDPSession(page);
      await cdpSession.send("Performance.enable");
      const beforeMetrics = await cdpSession.send("Performance.getMetrics");
      const taskDurationBefore = beforeMetrics.metrics.find(
        (metric) => metric.name === "TaskDuration",
      )!.value;
      await page.evaluate(() => {
        const scope = window as ScopedWindow;
        scope.ocIdleProbe = { longTasks: 0, longTaskMs: 0 };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            scope.ocIdleProbe!.longTasks += 1;
            scope.ocIdleProbe!.longTaskMs += entry.duration;
          }
        }).observe({ entryTypes: ["longtask"] });
      });

      await new Promise((resolve) => {
        setTimeout(resolve, IDLE_WINDOW_MS);
      });

      const afterMetrics = await cdpSession.send("Performance.getMetrics");
      const taskDurationAfter = afterMetrics.metrics.find(
        (metric) => metric.name === "TaskDuration",
      )!.value;
      const taskDurationMs = (taskDurationAfter - taskDurationBefore) * 1_000;
      const idle = await page.evaluate(() => (window as ScopedWindow).ocIdleProbe!);
      await recordBudgetMetrics("idle-quiescence", {
        longTasks: idle.longTasks,
        longTaskMs: Math.round(idle.longTaskMs),
        taskDurationMs: Math.round(taskDurationMs),
      });

      expect(idle.longTaskMs).toBeLessThanOrEqual(IDLE_LONGTASK_TOTAL_CEILING_MS);
      expect(taskDurationMs).toBeLessThanOrEqual(IDLE_TASK_DURATION_CEILING_MS);
    });
  });
});
