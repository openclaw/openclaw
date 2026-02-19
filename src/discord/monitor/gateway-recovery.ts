import type { EventEmitter } from "node:events";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { danger, warn } from "../../globals.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import type { RuntimeEnv } from "../../runtime.js";

const RESUME_ATTEMPT_MARKER = "Attempting resume with backoff";
const RECONNECT_MARKER = "Reconnecting with backoff";
const CLOSE_MARKER = "WebSocket connection closed with code";
const STABLE_MARKER = "connection stable";

export type DiscordGatewayRecoveryPolicy = {
  maxConsecutiveResumeFailures: number;
  resetWindowMs: number;
};

export type DiscordGatewayOuterRetryPolicy = {
  maxOuterRetries: number;
  backoff: BackoffPolicy;
};

export type DiscordGatewayRecoveryState = {
  consecutiveResumeFailures: number;
  isResuming: boolean;
  shouldTrip: boolean;
};

type GatewayEmitter = Pick<EventEmitter, "on" | "removeListener">;

type MutableGatewayState = {
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  sequence: number | null;
};

type MutableGatewayInternals = {
  state?: MutableGatewayState;
  sequence?: number | null;
  pings?: unknown[];
  disconnect?: () => void;
  connect?: (resume?: boolean) => void;
};

type SleepFn = (ms: number, abortSignal?: AbortSignal) => Promise<void>;
type ComputeDelayFn = (policy: BackoffPolicy, attempt: number) => number;

const DEFAULT_RECOVERY_POLICY: DiscordGatewayRecoveryPolicy = {
  maxConsecutiveResumeFailures: 3,
  resetWindowMs: 60_000,
};

const DEFAULT_OUTER_RETRY_POLICY: DiscordGatewayOuterRetryPolicy = {
  maxOuterRetries: 5,
  backoff: {
    initialMs: 10_000,
    maxMs: 120_000,
    factor: 1.8,
    jitter: 0.2,
  },
};

function mergeRecoveryPolicy(
  policy?: Partial<DiscordGatewayRecoveryPolicy>,
): DiscordGatewayRecoveryPolicy {
  return {
    ...DEFAULT_RECOVERY_POLICY,
    ...policy,
  };
}

function mergeOuterRetryPolicy(
  policy?: Partial<DiscordGatewayOuterRetryPolicy>,
): DiscordGatewayOuterRetryPolicy {
  return {
    ...DEFAULT_OUTER_RETRY_POLICY,
    ...policy,
    backoff: {
      ...DEFAULT_OUTER_RETRY_POLICY.backoff,
      ...policy?.backoff,
    },
  };
}

export class DiscordGatewayRecoveryTracker {
  private readonly gateway: MutableGatewayInternals;
  private readonly policy: DiscordGatewayRecoveryPolicy;
  private readonly now: () => number;
  private isResuming = false;
  private consecutiveResumeFailures = 0;
  private lastFailureMs: number | undefined;

  constructor(params: {
    gateway: GatewayPlugin;
    policy?: Partial<DiscordGatewayRecoveryPolicy>;
    now?: () => number;
  }) {
    this.gateway = params.gateway as unknown as MutableGatewayInternals;
    this.policy = mergeRecoveryPolicy(params.policy);
    this.now = params.now ?? Date.now;
  }

  handleDebugMessage(message: string): { tripped: boolean } {
    if (message.includes(STABLE_MARKER)) {
      this.reset();
      return { tripped: false };
    }

    if (message.includes(RESUME_ATTEMPT_MARKER)) {
      // If we see another resume attempt while still marked resuming,
      // the previous resume failed without an explicit close marker.
      if (this.isResuming) {
        const result = this.recordResumeFailure();
        if (result.tripped) {
          return result;
        }
      }
      this.isResuming = true;
      return { tripped: false };
    }

    if (this.isResuming && (message.includes(CLOSE_MARKER) || message.includes(RECONNECT_MARKER))) {
      return this.recordResumeFailure();
    }

    return { tripped: false };
  }

  getState(): DiscordGatewayRecoveryState {
    return {
      consecutiveResumeFailures: this.consecutiveResumeFailures,
      isResuming: this.isResuming,
      shouldTrip: this.consecutiveResumeFailures >= this.policy.maxConsecutiveResumeFailures,
    };
  }

  private resetIfWindowExpired() {
    if (this.lastFailureMs === undefined) {
      return;
    }
    if (this.now() - this.lastFailureMs > this.policy.resetWindowMs) {
      this.consecutiveResumeFailures = 0;
    }
  }

  private reset() {
    this.isResuming = false;
    this.consecutiveResumeFailures = 0;
    this.lastFailureMs = undefined;
  }

  private forceFreshIdentify() {
    const state = this.gateway.state;
    if (state) {
      state.sessionId = null;
      state.resumeGatewayUrl = null;
      state.sequence = null;
    }
    this.gateway.sequence = null;
    if (Array.isArray(this.gateway.pings)) {
      this.gateway.pings.length = 0;
    }
    this.gateway.disconnect?.();
    this.gateway.connect?.(false);
  }

  private recordResumeFailure(): { tripped: boolean } {
    this.isResuming = false;
    this.resetIfWindowExpired();
    this.consecutiveResumeFailures += 1;
    this.lastFailureMs = this.now();
    if (this.consecutiveResumeFailures >= this.policy.maxConsecutiveResumeFailures) {
      this.forceFreshIdentify();
      this.reset();
      return { tripped: true };
    }
    return { tripped: false };
  }
}

export function attachDiscordGatewayRecovery(params: {
  emitter?: GatewayEmitter;
  gateway?: GatewayPlugin;
  runtime: RuntimeEnv;
  policy?: Partial<DiscordGatewayRecoveryPolicy>;
  now?: () => number;
  shouldIgnoreMessage?: () => boolean;
}) {
  const { emitter, gateway, runtime } = params;
  if (!emitter || !gateway) {
    return () => {};
  }

  const tracker = new DiscordGatewayRecoveryTracker({
    gateway,
    policy: params.policy,
    now: params.now,
  });

  const onDebug = (msg: unknown) => {
    if (params.shouldIgnoreMessage?.()) {
      return;
    }
    const message = String(msg);
    const result = tracker.handleDebugMessage(message);
    if (result.tripped) {
      runtime.log?.(
        warn(
          "discord: resume circuit breaker tripped after consecutive failures; forcing fresh identify",
        ),
      );
      runtime.log?.(
        danger("discord: cleared stale gateway session and reconnected without resume"),
      );
    }
  };

  emitter.on("debug", onDebug);
  return () => emitter.removeListener("debug", onDebug);
}

export function shouldRetryDiscordGatewayError(err: unknown): boolean {
  const message = String(err);
  return message.includes("Max reconnect attempts");
}

export function shouldStopDiscordGatewayError(err: unknown): boolean {
  const message = String(err);
  return message.includes("Max reconnect attempts") || message.includes("Fatal Gateway error");
}

export async function runDiscordGatewayWithOuterRetry(params: {
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  policy?: Partial<DiscordGatewayOuterRetryPolicy>;
  runOnce: (outerAttempt: number) => Promise<void>;
  shouldRetryOnError?: (err: unknown) => boolean;
  sleep?: SleepFn;
  computeDelay?: ComputeDelayFn;
}) {
  const policy = mergeOuterRetryPolicy(params.policy);
  const shouldRetryOnError = params.shouldRetryOnError ?? shouldRetryDiscordGatewayError;
  const sleep = params.sleep ?? sleepWithAbort;
  const computeDelay = params.computeDelay ?? computeBackoff;
  let lastRetryableError: unknown;

  for (let outerAttempt = 0; outerAttempt <= policy.maxOuterRetries; outerAttempt++) {
    if (params.abortSignal?.aborted) {
      return;
    }
    try {
      await params.runOnce(outerAttempt);
      return;
    } catch (err) {
      if (!shouldRetryOnError(err)) {
        throw err;
      }
      lastRetryableError = err;
      if (outerAttempt >= policy.maxOuterRetries) {
        break;
      }

      const delayMs = computeDelay(policy.backoff, outerAttempt + 1);
      params.runtime.log?.(
        danger(
          `discord: gateway exhausted reconnect attempts, outer retry ${outerAttempt + 1}/${policy.maxOuterRetries} in ${Math.round(delayMs / 1000)}s`,
        ),
      );
      try {
        await sleep(delayMs, params.abortSignal);
      } catch (sleepErr) {
        if (params.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }

  throw new Error(
    `discord: gateway failed after ${policy.maxOuterRetries} outer retries — marking channel as dead`,
    { cause: lastRetryableError },
  );
}
