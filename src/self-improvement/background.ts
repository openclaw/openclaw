import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runSelfImprovementAnalysis } from "./analysis.js";
import { appendSelfImprovementAuditEvent } from "./audit-events.js";
import { writeSelfImprovementOperationalHealthSnapshot } from "./operational-health.js";
import { runSelfImprovementGovernorScan } from "./runner.js";

const DEFAULT_SELF_IMPROVEMENT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_SELF_IMPROVEMENT_INITIAL_DELAY_MS = 5 * 60_000;
const DEFAULT_SELF_IMPROVEMENT_ANALYSIS_LIMIT = 25;
const MIN_SELF_IMPROVEMENT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_SELF_IMPROVEMENT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_SELF_IMPROVEMENT_JITTER_RATIO = 0.1;

type SelfImprovementBackgroundScan = typeof runSelfImprovementGovernorScan;
type SelfImprovementBackgroundAnalysis = typeof runSelfImprovementAnalysis;

async function recordBackgroundCycleHealth(params: {
  success: boolean;
  analysisLimit: number;
  log?: { error: (message: string) => void };
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}) {
  const now = Date.now();
  try {
    await appendSelfImprovementAuditEvent({
      event: {
        createdAt: now,
        actor: "governor",
        kind: "background_cycle",
        targetId: "self-improvement-background",
        summary: params.skipped
          ? "Skipped Self-Improvement background cycle."
          : params.success
            ? "Completed Self-Improvement background cycle."
            : "Self-Improvement background cycle failed.",
        metadata: {
          success: params.success,
          ...(params.skipped ? { skipped: true } : {}),
          ...(params.skipReason ? { skipReason: params.skipReason } : {}),
          ...(params.success ? { analysisLimit: params.analysisLimit } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
      },
    });
    await writeSelfImprovementOperationalHealthSnapshot({ now, actor: "governor" });
  } catch (error) {
    params.log?.error(
      `self-improvement operational health recording failed: ${formatErrorMessage(error)}`,
    );
  }
}

function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_SELF_IMPROVEMENT_INTERVAL_MS?.trim();
  if (!raw) {
    return DEFAULT_SELF_IMPROVEMENT_INTERVAL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(MIN_SELF_IMPROVEMENT_INTERVAL_MS, Math.floor(parsed))
    : DEFAULT_SELF_IMPROVEMENT_INTERVAL_MS;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_SELF_IMPROVEMENT_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_SELF_IMPROVEMENT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1_000, Math.floor(parsed))
    : DEFAULT_SELF_IMPROVEMENT_TIMEOUT_MS;
}

function jitterDelayMs(params: {
  baseMs: number;
  jitterRatio: number;
  random: () => number;
}): number {
  if (params.jitterRatio <= 0 || params.baseMs <= 0) {
    return params.baseMs;
  }
  const boundedRandom = Math.min(1, Math.max(0, params.random()));
  const maxJitter = Math.floor(params.baseMs * params.jitterRatio);
  return params.baseMs + Math.floor(boundedRandom * maxJitter);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Self-Improvement background cycle timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function startSelfImprovementGovernorBackgroundTask(params: {
  getRuntimeConfig: () => OpenClawConfig;
  listCronJobs?: () => Promise<CronJob[]>;
  log?: { error: (message: string) => void };
  intervalMs?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  jitterRatio?: number;
  analysisLimit?: number;
  analyzeAfterScan?: boolean;
  recordOperationalHealth?: boolean;
  runScan?: SelfImprovementBackgroundScan;
  runAnalysis?: SelfImprovementBackgroundAnalysis;
  env?: NodeJS.ProcessEnv;
  random?: () => number;
}): {
  interval: ReturnType<typeof setInterval>;
  initial: ReturnType<typeof setTimeout>;
  runNow: () => Promise<void>;
} {
  let inFlight: Promise<void> | null = null;
  const runNow = async () => {
    if (inFlight) {
      if (params.recordOperationalHealth !== false) {
        await recordBackgroundCycleHealth({
          success: true,
          skipped: true,
          skipReason: "overlap",
          analysisLimit: params.analysisLimit ?? DEFAULT_SELF_IMPROVEMENT_ANALYSIS_LIMIT,
          log: params.log,
        });
      }
      return;
    }
    inFlight = (async () => {
      const timeoutMs = params.timeoutMs ?? resolveTimeoutMs(params.env ?? process.env);
      await withTimeout(
        (async () => {
          const cfg = params.getRuntimeConfig();
          await (params.runScan ?? runSelfImprovementGovernorScan)({
            cfg,
            trigger: "background",
            listCronJobs: params.listCronJobs,
          });
          if (params.analyzeAfterScan === false) {
            return;
          }
          await (params.runAnalysis ?? runSelfImprovementAnalysis)({
            cfg,
            limit: params.analysisLimit ?? DEFAULT_SELF_IMPROVEMENT_ANALYSIS_LIMIT,
            writeHealthSnapshot: false,
          });
          if (params.recordOperationalHealth !== false) {
            await recordBackgroundCycleHealth({
              success: true,
              analysisLimit: params.analysisLimit ?? DEFAULT_SELF_IMPROVEMENT_ANALYSIS_LIMIT,
              log: params.log,
            });
          }
        })(),
        timeoutMs,
      );
    })()
      .then(() => undefined)
      .catch(async (error) => {
        const message = formatErrorMessage(error);
        params.log?.error(`self-improvement background cycle failed: ${message}`);
        if (params.recordOperationalHealth !== false) {
          await recordBackgroundCycleHealth({
            success: false,
            analysisLimit: params.analysisLimit ?? DEFAULT_SELF_IMPROVEMENT_ANALYSIS_LIMIT,
            log: params.log,
            error: message,
          });
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  };
  const intervalMs = params.intervalMs ?? resolveIntervalMs(params.env ?? process.env);
  const jitterRatio = params.jitterRatio ?? DEFAULT_SELF_IMPROVEMENT_JITTER_RATIO;
  const random = params.random ?? Math.random;
  const initialDelayMs =
    params.initialDelayMs ??
    jitterDelayMs({
      baseMs: DEFAULT_SELF_IMPROVEMENT_INITIAL_DELAY_MS,
      jitterRatio,
      random,
    });
  const intervalDelayMs = jitterDelayMs({
    baseMs: intervalMs,
    jitterRatio,
    random,
  });
  const interval = setInterval(() => {
    void runNow();
  }, intervalDelayMs);
  const initial = setTimeout(() => {
    void runNow();
  }, initialDelayMs);
  interval.unref?.();
  initial.unref?.();
  return { interval, initial, runNow };
}
