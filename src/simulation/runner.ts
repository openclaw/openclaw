import {
  enqueueCommandInLane,
  getAllLaneInfo,
  resetLanesByPrefix,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { createFakeStreamFn } from "./fake-provider.js";
import { MessageTracker } from "./message-tracker.js";
import { QueueMonitor } from "./queue-monitor.js";
import { buildReport } from "./report.js";
import { detectSymptoms } from "./symptom-detector.js";
import type { ScenarioConfig, SimInboundMessage, SimOutboundMessage, SimReport } from "./types.js";
import { mulberry32 } from "./types.js";
import { uuidv7 } from "./uuidv7.js";

export type RunSimulationOptions = {
  signal?: AbortSignal;
  verbose?: boolean;
  onEvent?: (msg: string) => void;
};

/**
 * Execute a simulation scenario and return a typed report.
 *
 * Pipeline: load scenario -> wire fakes -> generate traffic -> monitor -> detect -> report
 */
export async function runSimulation(
  scenario: ScenarioConfig,
  opts?: RunSimulationOptions,
): Promise<SimReport> {
  const runId = uuidv7();
  const lanePrefix = `sim:${runId}:`;
  const startedAt = new Date();
  const tracker = new MessageTracker();
  const controller = new AbortController();
  const signal = opts?.signal;
  const log = opts?.onEvent ?? (() => {});

  // Link external abort signal
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  // Seeded PRNG for reproducibility
  const rng = scenario.seed !== undefined ? mulberry32(scenario.seed) : undefined;

  log(`[sim] run=${runId} scenario=${scenario.name}`);

  // Wire fake provider — flatten all models by ID.
  // If two providers declare the same modelId the last one wins (log a warning).
  const allModels: Record<string, { latencyMs: number; response: string; errorRate?: number }> = {};
  for (const [providerName, providerDef] of Object.entries(scenario.providers)) {
    for (const [modelId, modelDef] of Object.entries(providerDef.models)) {
      if (allModels[modelId]) {
        log(
          `[sim] warning: duplicate model "${modelId}" in provider "${providerName}" — overwriting`,
        );
      }
      allModels[modelId] = modelDef;
    }
  }
  const fakeStreamFn = createFakeStreamFn({
    models: allModels,
    tracker,
    signal: controller.signal,
    rng,
  });

  // Configure lane concurrency from scenario config (guard against NaN from bad casts)
  const rawConcurrent =
    (scenario.config?.agents?.defaults?.maxConcurrent as number | undefined) ?? 1;
  const maxConcurrent = Number.isFinite(rawConcurrent) && rawConcurrent > 0 ? rawConcurrent : 1;

  // Start queue monitor
  const monitor = new QueueMonitor();
  const sampleIntervalMs = scenario.monitor?.sampleIntervalMs ?? 100;
  monitor.start(sampleIntervalMs, lanePrefix);

  log(`[sim] monitor started, sampleIntervalMs=${sampleIntervalMs}`);

  // Wrap in try/finally so monitor and lanes are always cleaned up,
  // even if generateTraffic throws (e.g. missing conversation ID)
  let timeline;
  try {
    // Generate traffic — all traffic groups start concurrently
    await generateTraffic(scenario, {
      tracker,
      controller,
      fakeStreamFn,
      lanePrefix,
      maxConcurrent,
      rng,
      log,
      verbose: opts?.verbose,
    });

    // Wait for all lanes to drain (poll until no queued or active tasks remain)
    if (!controller.signal.aborted) {
      const maxLatency = Math.max(...Object.values(allModels).map((m) => m.latencyMs), 1000);
      const drainDeadline = Date.now() + maxLatency * 5 + 5000;
      log(`[sim] waiting for lane drain`);
      await waitForLaneDrain(lanePrefix, drainDeadline, controller.signal);
    }
  } finally {
    // Stop monitor and clean up simulation lanes
    timeline = monitor.stop();
    resetLanesByPrefix(lanePrefix);
  }

  log(`[sim] complete, messages=${tracker.size}`);

  // Detect symptoms
  const symptoms = detectSymptoms({
    messages: tracker.messages(),
    timeline,
    thresholds: scenario.symptoms,
  });

  // Build and return report
  return buildReport({
    scenarioName: scenario.name,
    seed: scenario.seed,
    startedAt,
    messages: tracker.messages(),
    timeline,
    symptoms,
    assertions: scenario.assertions,
  });
}

// ── Lane drain polling ───────────────────────────────────────────────

const DRAIN_POLL_MS = 50;

async function waitForLaneDrain(
  lanePrefix: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  while (Date.now() < deadline && !signal.aborted) {
    const lanes = getAllLaneInfo(lanePrefix);
    const busy = lanes.some((l) => l.queued > 0 || l.active > 0);
    if (!busy) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
}

// ── Traffic generation ───────────────────────────────────────────────

type TrafficContext = {
  tracker: MessageTracker;
  controller: AbortController;
  fakeStreamFn: ReturnType<typeof createFakeStreamFn>;
  lanePrefix: string;
  maxConcurrent: number;
  rng?: () => number;
  log: (msg: string) => void;
  verbose?: boolean;
};

async function generateTraffic(scenario: ScenarioConfig, ctx: TrafficContext): Promise<void> {
  // Launch all traffic groups concurrently so startAtMs is relative to sim start
  const groupPromises: Promise<void>[] = [];

  for (const traffic of scenario.traffic) {
    const conv = scenario.conversations.find((c) => c.id === traffic.conversation);
    if (!conv) {
      throw new Error(`Conversation ${traffic.conversation} not found in scenario`);
    }

    const laneName = `${ctx.lanePrefix}session:${conv.channel}:${conv.chatType}:${conv.peer}`;
    setCommandLaneConcurrency(laneName, ctx.maxConcurrent);

    const messagePromises: Promise<void>[] = [];

    // Pre-compute cumulative delays for random pattern (proper Poisson process)
    const delays = computeDelays(traffic.pattern, traffic.count, traffic.intervalMs, ctx.rng);

    for (let i = 0; i < traffic.count; i++) {
      if (ctx.controller.signal.aborted) {
        break;
      }

      const senderId = traffic.senderIds[i % traffic.senderIds.length];
      const startAtMs = traffic.startAtMs + delays[i];

      const p = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (ctx.controller.signal.aborted) {
            resolve();
            return;
          }

          const inbound: Omit<SimInboundMessage, "seq"> = {
            id: uuidv7(),
            ts: Date.now(),
            direction: "inbound",
            conversationId: conv.id,
            text: `Message ${i + 1} from ${senderId}`,
            senderId,
            lane: laneName,
          };
          const recorded = ctx.tracker.record(inbound);

          if (ctx.verbose) {
            ctx.log(`[sim] inbound: conv=${conv.id} sender=${senderId} id=${recorded.id}`);
          }

          // Enqueue a simulated agent run.
          // NOTE: This calls fakeStreamFn directly instead of runEmbeddedPiAgent,
          // so it exercises queue/lane concurrency but not the full agent pipeline
          // (model resolution, auth profiles, failover/retry, rate limiting).
          const enqueueTs = Date.now();
          void enqueueCommandInLane(laneName, async () => {
            const queueWaitMs = Date.now() - enqueueTs;
            const runStart = Date.now();
            const model = scenario.agents[0];
            const streamOrPromise = ctx.fakeStreamFn(
              { id: model.model, contextWindow: 8192 } as never,
              {
                messages: [{ role: "user", content: recorded.text }],
              } as never,
              {} as never,
            );
            const stream =
              streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;

            // Consume the async iterable to drive the stream to completion
            let responseText: string | undefined;
            for await (const evt of stream) {
              if (evt.type === "done") {
                responseText = evt.message.content
                  .filter((c): c is { type: "text"; text: string } => c.type === "text")
                  .map((c) => c.text)
                  .join("");
                break;
              }
              if (ctx.controller.signal.aborted || evt.type === "error") {
                break;
              }
            }

            // Only record outbound for successful completions — errors/aborts
            // should not count as replies (they distort symptom ratios)
            if (responseText !== undefined) {
              const outbound: Omit<SimOutboundMessage, "seq"> = {
                id: uuidv7(),
                ts: Date.now(),
                direction: "outbound",
                conversationId: conv.id,
                text: responseText,
                agentId: model.id,
                causalParentId: recorded.id,
                causalParentTs: recorded.ts,
                queueWaitMs,
                runDurationMs: Date.now() - runStart,
              };
              ctx.tracker.record(outbound);

              if (ctx.verbose) {
                ctx.log(
                  `[sim] outbound: conv=${conv.id} agent=${model.id} wait=${queueWaitMs}ms id=${outbound.id}`,
                );
              }
            }
          }).catch(() => {
            // Lane cleared errors are expected on abort
          });

          resolve();
        }, startAtMs);

        ctx.controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      messagePromises.push(p);
    }

    groupPromises.push(Promise.all(messagePromises).then(() => {}));
  }

  await Promise.all(groupPromises);
}

// ── Traffic pattern delay computation ────────────────────────────────

/**
 * Pre-compute delays for all messages in a traffic group.
 * Returns an array of absolute delays (ms) from group start.
 *
 * - burst: all at time 0
 * - steady: evenly spaced by intervalMs
 * - random: cumulative Poisson inter-arrivals (proper arrival process)
 */
function computeDelays(
  pattern: string,
  count: number,
  intervalMs: number,
  rng?: () => number,
): number[] {
  const delays: number[] = [];
  switch (pattern) {
    case "burst": {
      for (let i = 0; i < count; i++) {
        delays.push(0);
      }
      break;
    }
    case "steady": {
      for (let i = 0; i < count; i++) {
        delays.push(i * intervalMs);
      }
      break;
    }
    case "random": {
      // Cumulative Poisson inter-arrivals: each gap is -ln(1-U) * mean
      let cumulative = 0;
      for (let i = 0; i < count; i++) {
        const u = rng ? rng() : Math.random();
        cumulative += Math.floor(-Math.log(1 - u) * intervalMs);
        delays.push(cumulative);
      }
      break;
    }
    default: {
      for (let i = 0; i < count; i++) {
        delays.push(i * intervalMs);
      }
      break;
    }
  }
  return delays;
}
