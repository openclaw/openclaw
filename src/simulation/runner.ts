import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  enqueueCommandInLane,
  resetLanesByPrefix,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { createFakeChannelPlugin } from "./fake-channel.js";
import { createFakeStreamFn } from "./fake-provider.js";
import { MessageTracker } from "./message-tracker.js";
import { QueueMonitor } from "./queue-monitor.js";
import { buildReport } from "./report.js";
import { detectSymptoms } from "./symptom-detector.js";
import type { ScenarioConfig, SimInboundMessage, SimReport } from "./types.js";
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

  // Temporary directory for session state isolation
  const tmpBase = resolvePreferredOpenClawTmpDir();
  const simDir = join(tmpBase, `sim-${runId}`);
  mkdirSync(simDir, { recursive: true });

  log(`[sim] run=${runId} scenario=${scenario.name} dir=${simDir}`);

  // Wire fake provider
  const allModels: Record<string, { latencyMs: number; response: string; errorRate?: number }> = {};
  for (const [, providerDef] of Object.entries(scenario.providers)) {
    for (const [modelId, modelDef] of Object.entries(providerDef.models)) {
      allModels[modelId] = modelDef;
    }
  }
  const fakeStreamFn = createFakeStreamFn({
    models: allModels,
    tracker,
    signal: controller.signal,
    rng,
  });

  // Wire fake channels
  const fakeChannels = new Map<string, ReturnType<typeof createFakeChannelPlugin>>();
  for (const ch of scenario.channels) {
    const plugin = createFakeChannelPlugin({
      channelType: ch.type,
      tracker,
      onOutbound: (msg) => {
        if (opts?.verbose) {
          log(`[sim] outbound: conv=${msg.conversationId} text=${msg.text}`);
        }
      },
    });
    fakeChannels.set(ch.type, plugin);
  }

  // Configure lane concurrency from scenario config
  const maxConcurrent =
    (scenario.config?.agents?.defaults?.maxConcurrent as number | undefined) ?? 1;

  // Start queue monitor
  const monitor = new QueueMonitor();
  const sampleIntervalMs = scenario.monitor?.sampleIntervalMs ?? 100;
  monitor.start(sampleIntervalMs, lanePrefix);

  log(`[sim] monitor started, sampleIntervalMs=${sampleIntervalMs}`);

  // Generate traffic and wait for drain
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

  // Wait for processing to complete (with timeout)
  if (!controller.signal.aborted) {
    const maxLatency = Math.max(...Object.values(allModels).map((m) => m.latencyMs), 1000);
    const drainTimeout = maxLatency * 3 + 2000;
    log(`[sim] waiting for drain, timeout=${drainTimeout}ms`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, drainTimeout);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // Stop monitor and clean up simulation lanes
  const timeline = monitor.stop();
  resetLanesByPrefix(lanePrefix);

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
  for (const traffic of scenario.traffic) {
    const conv = scenario.conversations.find((c) => c.id === traffic.conversation);
    if (!conv) {
      throw new Error(`Conversation ${traffic.conversation} not found in scenario`);
    }

    const laneName = `${ctx.lanePrefix}session:${conv.channel}:${conv.chatType}:${conv.peer}`;
    setCommandLaneConcurrency(laneName, ctx.maxConcurrent);

    const messagePromises: Promise<void>[] = [];

    for (let i = 0; i < traffic.count; i++) {
      if (ctx.controller.signal.aborted) {
        break;
      }

      const senderId = traffic.senderIds[i % traffic.senderIds.length];
      const delayMs = computeDelay(traffic.pattern, i, traffic.intervalMs, ctx.rng);
      const startAtMs = traffic.startAtMs + delayMs;

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

          // Enqueue a simulated agent run
          void enqueueCommandInLane(laneName, async () => {
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
            for await (const evt of stream) {
              if (ctx.controller.signal.aborted || evt.type === "done" || evt.type === "error") {
                break;
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

    await Promise.all(messagePromises);
  }
}

// ── Traffic pattern delay computation ────────────────────────────────

function computeDelay(
  pattern: string,
  index: number,
  intervalMs: number,
  rng?: () => number,
): number {
  switch (pattern) {
    case "burst":
      return index * intervalMs;
    case "steady":
      return index * intervalMs;
    case "random": {
      // Poisson inter-arrival: -ln(U) * mean
      const u = rng ? rng() : Math.random();
      return Math.floor(-Math.log(1 - u) * intervalMs);
    }
    default:
      return index * intervalMs;
  }
}
