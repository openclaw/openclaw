import { randomInt } from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { FailoverError } from "../agents/failover/error.js";
import {
  hasOrganizationTpmRateLimitEvidence,
  resolveRetryAfterMs,
} from "../agents/failover/retry-evidence.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "./types.js";

type Waiter = {
  order: number;
  priority: "interactive" | "background";
  maxRetryDelayMs: number;
  gate: Gate;
  signal?: AbortSignal;
  abort: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  onWait?: (retryAt: number) => () => void;
  stopWaiting?: () => void;
  done: boolean;
};

type Gate = {
  keys: Set<string>;
  retryAt: number;
  nextAt: number;
  expiresAt: number;
  queue: Waiter[];
  timer?: ReturnType<typeof setTimeout>;
};

// Source and built SDK consumers can coexist in one process.
const state = resolveGlobalSingleton(Symbol.for("openclaw.providerRateLimit"), () => ({
  gates: new Map<string, Gate>(),
  waiterOrder: 0,
}));
const { gates } = state;
const admittedAccount = Symbol.for("openclaw.providerRateLimit.admittedAccount");

function stopWaiting(waiter: Waiter) {
  try {
    waiter.stopWaiting?.();
  } catch {
    // Status reporting must not hold provider admission open.
  }
  waiter.stopWaiting = undefined;
}

function notify(waiter: Waiter) {
  stopWaiting(waiter);
  const floorMs = waiter.gate.retryAt - Date.now();
  if (waiter.maxRetryDelayMs > 0 && floorMs > waiter.maxRetryDelayMs) {
    waiter.gate.queue.splice(waiter.gate.queue.indexOf(waiter), 1);
    finish(
      waiter,
      new FailoverError(
        `429 Shared organization token rate limit. Retry-After: ${floorMs / 1000} seconds exceeds maxRetryDelayMs=${waiter.maxRetryDelayMs}.`,
        { reason: "rate_limit", status: 429, code: "rate_limit_exceeded" },
      ),
    );
    return;
  }
  try {
    waiter.stopWaiting = waiter.onWait?.(Math.max(waiter.gate.retryAt, waiter.gate.nextAt));
  } catch {
    // Status reporting is best effort; the queue still owns admission.
  }
  if (waiter.done) {
    stopWaiting(waiter);
  }
}

function finish(waiter: Waiter, error?: unknown) {
  waiter.done = true;
  waiter.signal?.removeEventListener("abort", waiter.abort);
  stopWaiting(waiter);
  if (error !== undefined) {
    waiter.reject(error);
  } else {
    waiter.resolve();
  }
}

function schedule(gate: Gate) {
  clearTimeout(gate.timer);
  const admissionAt = Math.max(gate.retryAt, gate.nextAt);
  const wakeAt = gate.queue.length ? Math.min(admissionAt, gate.expiresAt) : gate.expiresAt;
  gate.timer = setTimeout(
    () => {
      if (Date.now() >= gate.expiresAt) {
        for (const key of gate.keys) {
          gates.delete(key);
        }
        gate.queue.splice(0).forEach((waiter) => finish(waiter));
        return;
      }
      if (Date.now() < admissionAt || !gate.queue.length) {
        schedule(gate);
        return;
      }
      const interactive = gate.queue.findIndex((waiter) => waiter.priority === "interactive");
      const released = gate.queue.splice(Math.max(0, interactive), 1);
      gate.nextAt = Date.now() + randomInt(100, 251);
      schedule(gate);
      released.forEach((waiter) => finish(waiter));
    },
    Math.min(2_147_483_647, Math.max(0, wakeAt - Date.now())),
  );
  if (!gate.queue.length) {
    gate.timer.unref();
  }
}

function merge(gate: Gate, other: Gate) {
  clearTimeout(other.timer);
  gate.retryAt = Math.max(gate.retryAt, other.retryAt);
  gate.nextAt = Math.max(gate.nextAt, other.nextAt);
  gate.expiresAt = Math.max(gate.expiresAt, other.expiresAt);
  for (const key of other.keys) {
    gate.keys.add(key);
    gates.set(key, gate);
  }
  for (const waiter of other.queue) {
    waiter.gate = gate;
    gate.queue.push(waiter);
  }
  gate.queue.sort((a, b) => a.order - b.order);
}

function requestIdentity(
  model: Pick<Model, "provider" | "baseUrl" | "headers">,
  options?: Pick<SimpleStreamOptions, "apiKey" | "headers">,
) {
  const headers = new Map(
    [...Object.entries(model.headers ?? {}), ...Object.entries(options?.headers ?? {})].map(
      ([name, value]) => [name.toLowerCase(), value] as const,
    ),
  );
  const scope = sha256Hex(JSON.stringify([model.provider, model.baseUrl]));
  const organization = headers.get("openai-organization");
  const credential = headers.get("authorization") ?? options?.apiKey;
  // Explicit organization selection can put the same credential in different buckets.
  const key = organization
    ? `${scope}:org:${sha256Hex(organization)}`
    : credential
      ? `${scope}:credential:${sha256Hex(credential.replace(/^Bearer\s+/i, ""))}`
      : undefined;
  return { scope, key };
}

/** Coordinates known shared TPM exhaustion; the caller remains the sole retry owner. */
export function createProviderRateLimitRequest<T extends SimpleStreamOptions>(
  model: Pick<Model, "provider" | "baseUrl" | "headers">,
  options: T & { [admittedAccount]?: string },
) {
  const { scope, key } = requestIdentity(model, options);
  const signal = options?.signal;
  const inherited = key !== undefined && options?.[admittedAccount] === key;

  return {
    // Delegating transports carry one admission to the physical request. A different
    // account must enter its own gate; unrelated calls do not inherit ambient admission.
    options: key ? { ...options, [admittedAccount]: key } : options,
    async wait(
      onWait?: (retryAt: number) => () => void,
      priority: "interactive" | "background" = "background",
    ): Promise<void> {
      signal?.throwIfAborted();
      const gate = key && !inherited ? gates.get(key) : undefined;
      if (!gate) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          order: state.waiterOrder++,
          priority,
          maxRetryDelayMs: options.maxRetryDelayMs ?? 60_000,
          gate,
          signal,
          resolve,
          reject,
          onWait,
          done: false,
          abort() {
            const queue = waiter.gate.queue;
            queue.splice(queue.indexOf(waiter), 1);
            finish(waiter, signal?.reason);
            schedule(waiter.gate);
          },
        };
        gate.queue.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        notify(waiter);
        schedule(gate);
      });
    },
    observe(message: AssistantMessage): void {
      if (
        !key ||
        inherited ||
        message.stopReason !== "error" ||
        !hasOrganizationTpmRateLimitEvidence(message.errorMessage) ||
        message.retryAfterMs === null
      ) {
        return;
      }
      const delay =
        message.retryAfterMs ??
        resolveRetryAfterMs(message.errorMessage, Date.now(), message.errorBody) ??
        1_000;
      if (!Number.isFinite(delay)) {
        return;
      }
      const org = message.errorMessage?.match(
        /\bin organization\s+(\S+)\s+on tokens per min/i,
      )?.[1];
      const orgKey = org ? `${scope}:org:${sha256Hex(org)}` : undefined;
      const gate = gates.get(key) ?? {
        keys: new Set([key]),
        retryAt: 0,
        nextAt: 0,
        expiresAt: 0,
        queue: [],
      };
      gates.set(key, gate);
      const orgGate = orgKey ? gates.get(orgKey) : undefined;
      if (orgGate && orgGate !== gate) {
        merge(gate, orgGate);
      }
      if (orgKey) {
        gate.keys.add(orgKey);
        gates.set(orgKey, gate);
      }
      gate.retryAt = Math.max(gate.retryAt, Date.now() + Math.max(0, delay));
      // Successful traffic must not perpetuate recovery pacing indefinitely.
      gate.expiresAt = gate.retryAt + 60_000;
      // A longer floor can remove waiters whose configured delay cap it exceeds.
      for (const waiter of gate.queue.slice()) {
        notify(waiter);
      }
      schedule(gate);
    },
  };
}
