import { expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import type { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";
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

const suite = createChatFlowE2eSuite();

type ChatFlowSuite = ReturnType<typeof createChatFlowE2eSuite>;
type ChatFlowPage = Parameters<Parameters<ChatFlowSuite["withPage"]>[1]>[0]["page"];

// Each delta lands in its own message task. The owner publication queue must
// coalesce them before the transcript changes.
const BURST_DELTA_COUNT = 240;
// The emitter crosses a frame halfway through, so both batches must reach DOM.
const MIN_BURST_MUTATION_BATCHES = 2;
// A direct DOM update per delta produces at least 240 batches. Measure the
// visible transcript instead of the retired generic page invalidation path.
const MAX_BURST_MUTATION_BATCHES = 180;
// Unrelated page timers can contribute one host update after the probe resets;
// ordinary characters must not invalidate the pane themselves.
const MAX_STEADY_COMPOSER_INVALIDATIONS = 1;

// Shipped live-tool ceiling: ui/src/pages/chat/tool-stream.ts TOOL_STREAM_LIMIT.
const TOOL_STREAM_LIMIT_CONTRACT = 50;
// Realistic agent cadence: narration deltas separate complete tool lifecycles.
// Calls stay above the shipped limit to prove eviction under sustained load.
const TOOL_FLOOD_PAIR_COUNT = 60;
// The lifecycle spans the 80ms projection throttle so start/update/input_delta
// exercise its deferred flush before result forces the final projection.
const TOOL_FLOOD_PHASE_INTERVAL_MS = 30;
// Gateway activity fencing drops any event whose seq is at or below the
// newest seq already accepted, so flood events seed above every sequence the
// mocked startup handshake has already delivered.
const TOOL_FLOOD_SEQ_SEED = 1_000_000;

const LONG_TRANSCRIPT_MESSAGE_COUNT = 400;
// Wall ceiling with multi-x headroom over the measured baseline
// (.artifacts/control-ui-e2e/stream-runtime-budgets/metrics.jsonl); sized to
// tolerate loaded shared runners while still failing quadratic transcript work.
const LONG_TRANSCRIPT_LOAD_CEILING_MS = 30_000;
const RICH_TURN_CHUNK_COUNT = 150;
// Post-GC resident JS heap after loading the long transcript and streaming the
// rich turn. Headroom over the measured baseline retains transient parser and
// renderer allocations; a leak that keeps streamed deltas alive breaks it.
const STREAM_SESSION_HEAP_CEILING_BYTES = 96 * 1024 * 1024;

const IDLE_WINDOW_MS = 4_000;
const IDLE_LONGTASK_TOTAL_CEILING_MS = 600;
const IDLE_TASK_DURATION_CEILING_MS = 600;

type StreamPerfProbe = {
  mutationBatches: number;
  invalidations: number;
  commits: number;
};

type ToolProjectionProbe = {
  beforeThrottleCardCount: number | null;
  afterThrottleCardCount: number | null;
  afterThrottleText: string | null;
  ready: boolean;
};

type ScopedWindow = Window & {
  openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  ocStreamPerf?: StreamPerfProbe;
  ocIdleProbe?: { longTasks: number; longTaskMs: number };
  ocBurstDone?: boolean;
  ocToolProjectionProbe?: ToolProjectionProbe;
  openclawControlUiE2eGateway?: {
    emit: (event: string, payload?: unknown) => void;
  };
};

// Rendered transcripts strip markdown markers, so visibility polls match the
// plain-text projection of the burst chunk emitted in-page
// (`delta N with **boldN** and \`codeN\` tail`).
function renderedChunkText(index: number): string {
  return `delta ${index} with bold${index} and code${index} tail`;
}

async function settleInitialModelCatalog(
  page: ChatFlowPage,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) {
  const name = "Runtime budget model";
  await gateway.waitForRequest("models.list");
  await gateway.resolveDeferred("models.list", {
    models: [{ id: "gpt-5.5", name, provider: "openai" }],
  });
  // A usable cached catalog can still be refreshing. Join this reply's rendered receipt.
  await waitForCommittedState(
    page,
    (modelName) =>
      document
        .querySelector(
          'openclaw-chat-pane.chat-pane-cache__pane--active [data-chat-model-select="true"]',
        )
        ?.textContent?.includes(modelName) === true,
    name,
  );
}

async function installRenderProbe(page: ChatFlowPage) {
  await page.evaluate(async () => {
    const scope = window as ScopedWindow;
    const chatPage = document.querySelector("openclaw-chat-page");
    if (!chatPage) {
      throw new Error("openclaw-chat-page is not mounted");
    }
    const thread = chatPage.querySelector(".chat-thread");
    if (!thread) {
      throw new Error("chat transcript is not mounted");
    }
    scope.ocStreamPerf = {
      mutationBatches: 0,
      invalidations: 0,
      commits: 0,
    };
    new MutationObserver((records) => {
      if (records.length > 0) {
        scope.ocStreamPerf!.mutationBatches += 1;
      }
    }).observe(thread, { childList: true, subtree: true, characterData: true });
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
    };
    // Drain already queued frames before the measured interaction.
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
      invalidations: 0,
      commits: 0,
    };
  });
}

async function readRenderProbe(page: ChatFlowPage): Promise<StreamPerfProbe> {
  return page.evaluate(() => (window as ScopedWindow).ocStreamPerf!);
}

// Socket-like message tasks avoid nested timers' 4ms clamp, which can spread a
// burst across enough frames to falsely exhaust the budget. Split at a real
// frame so the sanity floor observes two streaming batches.
async function emitDeltaBurstInPage(
  page: ChatFlowPage,
  runId: string,
  count: number,
): Promise<void> {
  await page.evaluate(
    ({ runId: targetRunId, count: targetCount }) => {
      const gateway = (window as ScopedWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      const scope = window as ScopedWindow;
      scope.ocBurstDone = false;
      let emitted = 0;
      const channel = new MessageChannel();
      const postNext = () => channel.port2.postMessage(null);
      const emitNext = () => {
        emitted += 1;
        const chunk = ` delta ${emitted} with **bold${emitted}** and \`code${emitted}\` tail`;
        gateway.emit("chat", {
          deltaText: chunk,
          message: {
            content: [{ text: chunk, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId: targetRunId,
          sessionKey: "main",
          state: "delta",
        });
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
    },
    { runId, count },
  );
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
  // One visible warm-up delta puts the transcript into the live streaming
  // state the burst and flood events attach to; it lands before any probe
  // counters reset, so measured windows stay clean.
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

async function probeDeferredToolProjection(page: ChatFlowPage, runId: string): Promise<void> {
  await page.evaluate(
    ({ runId: targetRunId, seqSeed, activity }) => {
      const scope = window as ScopedWindow;
      const gateway = scope.openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      const probe: ToolProjectionProbe = {
        beforeThrottleCardCount: null,
        afterThrottleCardCount: null,
        afterThrottleText: null,
        ready: false,
      };
      scope.ocToolProjectionProbe = probe;
      let seq = seqSeed;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) => {
        gateway.emit("agent", {
          data: { name: "edit", phase, toolCallId: "call-1", ...data },
          runId: targetRunId,
          seq: ++seq,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });
      };
      const cardSelector = '[data-message-id^="tool:assistant:call-1:"]';
      gateway.emit("chat", {
        deltaText: " working on step 1",
        message: {
          content: [{ text: " working on step 1", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: targetRunId,
        sessionKey: "main",
        state: "delta",
      });
      gateway.emit("agent", {
        data: activity,
        runId: targetRunId,
        seq: ++seq,
        sessionKey: "main",
        stream: "item",
        ts: Date.now(),
      });
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
    { runId, seqSeed: TOOL_FLOOD_SEQ_SEED, activity: toolFloodActivity(1, "start") },
  );
  await page.waitForFunction(
    () => (window as ScopedWindow).ocToolProjectionProbe?.ready === true,
    undefined,
    { timeout: 10_000, polling: 20 },
  );
}

async function completeFirstToolLifecycle(page: ChatFlowPage, runId: string): Promise<void> {
  await page.evaluate(
    ({ runId: targetRunId, seq, activity }) => {
      const gateway = (window as ScopedWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      gateway.emit("agent", {
        data: {
          name: "edit",
          phase: "result",
          result: "tool output 1",
          toolCallId: "call-1",
        },
        runId: targetRunId,
        seq,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      gateway.emit("agent", {
        data: activity,
        runId: targetRunId,
        seq: seq + 1,
        sessionKey: "main",
        stream: "item",
        ts: Date.now(),
      });
    },
    { runId, seq: TOOL_FLOOD_SEQ_SEED + 5, activity: toolFloodActivity(1, "result") },
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
  runId: string,
  pairCount: number,
): Promise<void> {
  // Gateway frames arrive as separate socket messages. Space each lifecycle
  // phase across timer ticks so the live stream exercises deferred projection,
  // not only the result path's forced flush.
  await page.evaluate(
    ({ runId: targetRunId, pairCount: targetPairCount, phaseIntervalMs, seqSeed, activities }) => {
      const scope = window as ScopedWindow;
      const gateway = scope.openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      scope.ocBurstDone = false;
      let emitted = 1;
      let seq = seqSeed + 6;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) => {
        gateway.emit("agent", {
          data: {
            name: "edit",
            phase,
            toolCallId: `call-${emitted}`,
            ...data,
          },
          runId: targetRunId,
          seq: ++seq,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });
      };
      const emitCall = () => {
        emitted += 1;
        const chunk = ` working on step ${emitted}`;
        gateway.emit("chat", {
          deltaText: chunk,
          message: {
            content: [{ text: chunk, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId: targetRunId,
          sessionKey: "main",
          state: "delta",
        });
        gateway.emit("agent", {
          data: activities[emitted - 2]!.start,
          runId: targetRunId,
          seq: ++seq,
          sessionKey: "main",
          stream: "item",
          ts: Date.now(),
        });
        emitToolPhase("start", { args: { path: `src/file-${emitted}.ts` } });
        setTimeout(() => {
          emitToolPhase("update", { partialResult: `partial output ${emitted}` });
          setTimeout(() => {
            emitToolPhase("input_delta", { diff: { added: emitted, removed: 1 } });
            setTimeout(() => {
              emitToolPhase("result", { result: `tool output ${emitted}` });
              gateway.emit("agent", {
                data: activities[emitted - 2]!.result,
                runId: targetRunId,
                seq: ++seq,
                sessionKey: "main",
                stream: "item",
                ts: Date.now(),
              });
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
      runId,
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
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.describe", "models.list"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await settleInitialModelCatalog(page, gateway);
      const runId = await openStreamingTurn(page, gateway, "burst coalescing probe");

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

      await emitDeltaBurstInPage(page, runId, BURST_DELTA_COUNT);
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
      // Text updates reach the transcript without re-preparing its page or pane.
      // The visible tail and mutation batches above prove the stream rendered.
      expect(probe.commits).toBe(0);
      expect(probe.mutationBatches).toBeGreaterThanOrEqual(MIN_BURST_MUTATION_BATCHES);
      expect(probe.mutationBatches).toBeLessThanOrEqual(MAX_BURST_MUTATION_BATCHES);
    });
  });

  it("keeps the live tool stream bounded under complete tool lifecycles", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const runId = await openStreamingTurn(page, gateway, "tool flood probe");

      await probeDeferredToolProjection(page, runId);
      const projection = await page.evaluate(() => (window as ScopedWindow).ocToolProjectionProbe!);
      expect(projection.beforeThrottleCardCount).toBe(0);
      expect(projection.afterThrottleCardCount).toBe(1);
      expect(projection.afterThrottleText).toContain("Editing");
      expect(projection.afterThrottleText).toContain("+1");
      expect(projection.afterThrottleText).toContain("-1");

      await completeFirstToolLifecycle(page, runId);
      const firstCard = page.locator('[data-message-id^="tool:assistant:call-1:"]');
      expect(await firstCard.count()).toBe(1);
      expect(await firstCard.textContent()).toContain("Edited");

      await emitRemainingToolLifecycleFlood(page, runId, TOOL_FLOOD_PAIR_COUNT);
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
      await emitDeltaBurstInPage(page, runId, RICH_TURN_CHUNK_COUNT);
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
        deferredMethods: ["models.list"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-thread-inner").getByText("LONG-TAIL-SENTINEL").waitFor();
      await settleInitialModelCatalog(page, gateway);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const scopeKey = "chat:v3:agent:main:main\u0000agent:main";
      await composer.fill("seed");
      await page.getByRole("button", { name: "Send message" }).waitFor();
      // The first saved draft notifies presence subscribers. Drain that transition
      // before measuring edits to an already-present draft.
      await waitForCommittedComposerDraft(page, scopeKey, "seed", 0);
      const scroll = scrollAwayAndBack
        ? await (async () => {
            const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
            await thread.hover();
            // Keep the saved offset inside the range when virtualizer measurements shrink it.
            await page.mouse.wheel(0, -200);
            await waitForChatScrollIdle(page);
            const originalTop = await thread.evaluate((element) => element.scrollTop);
            // Real reader input retires end-follow; an 8 px offset is still at the end.
            await page.mouse.wheel(0, -100);
            await expect
              .poll(() => thread.evaluate((element) => element.scrollTop))
              .toBeLessThan(originalTop - 8);
            // Virtualizer measurements can adjust the wheel's final offset.
            await waitForChatScrollIdle(page);
            const awayTop = await thread.evaluate((element) => element.scrollTop);
            await page.mouse.wheel(0, originalTop - awayTop);
            await expect
              .poll(() => thread.evaluate((element) => element.scrollTop))
              .toBe(originalTop);
            return {
              originalTop,
              awayTop,
              restoredTop: await thread.evaluate((element) => element.scrollTop),
            };
          })()
        : null;
      // Finish startup scrolling before measuring steady-state composer invalidations.
      await waitForChatScrollIdle(page);
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
      expect(idle.longTaskMs).toBeLessThanOrEqual(IDLE_LONGTASK_TOTAL_CEILING_MS);
      expect(taskDurationMs).toBeLessThanOrEqual(IDLE_TASK_DURATION_CEILING_MS);
    });
  });
});
