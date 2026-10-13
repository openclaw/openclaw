import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type {
  OpenClawStateAsyncLeaseContext,
  OpenClawStateLeaseContext,
} from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import type { OpenClawStateLeaseDatabase } from "./openclaw-state-lease-storage.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type OpenClawStateLeaseOptions = {
  scope: string;
  key: string;
  database: OpenClawStateLeaseDatabase;
  leaseMs: number;
  waitMs: number;
  signal?: AbortSignal;
  /** Maintenance prepares normal storage before waiting for its operation lease. */
  prepareDatabase?: boolean;
  /** Maintenance can block the event loop for longer than the lease duration. */
  heartbeat?: "worker";
  /** Opt in only when no write-capable work can outlive the owning process. */
  processBound?: boolean;
  /** Stable diagnostic noun used in errors. */
  leaseLabel?: string;
  /** Stable transaction label used by SQLite diagnostics. */
  operationLabel?: string;
};

export type OpenClawStateLeaseInvocation<T> =
  | {
      kind: "native";
      options: OpenClawStateLeaseOptions;
      run: (lease: OpenClawStateLeaseContext) => Promise<T>;
    }
  | {
      kind: "worker";
      options: OpenClawStateLeaseOptions;
      context: OpenClawStateWorkerContext;
      run: (lease: OpenClawStateAsyncLeaseContext) => Promise<T>;
    };

const MIN_LEASE_MS = 1_000;
function invalidInput(message: string): OpenClawStateLeaseError {
  return new OpenClawStateLeaseError(message, { code: "OPENCLAW_STATE_LEASE_INVALID_INPUT" });
}

function validateDuration(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw invalidInput(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

export function validateOpenClawStateLeaseOptions(options: OpenClawStateLeaseOptions) {
  const database = options.database;
  const leaseLabel =
    options.leaseLabel === undefined
      ? "state lease"
      : validateNonEmptyString(options.leaseLabel, "state lease label");
  const operationLabel =
    options.operationLabel === undefined
      ? "state.lease"
      : validateNonEmptyString(options.operationLabel, "state lease operationLabel");
  return {
    scope: validateNonEmptyString(options.scope, `${leaseLabel} scope`),
    key: validateNonEmptyString(options.key, `${leaseLabel} key`),
    database,
    leaseMs: validateDuration(
      options.leaseMs,
      `${leaseLabel} leaseMs`,
      MIN_LEASE_MS,
      MAX_TIMER_TIMEOUT_MS,
    ),
    waitMs: validateDuration(options.waitMs, `${leaseLabel} waitMs`, 0, MAX_TIMER_TIMEOUT_MS),
    signal: options.signal,
    prepareDatabase: options.prepareDatabase === true,
    heartbeat: options.heartbeat,
    processBound: options.processBound === true,
    leaseLabel,
    operationLabel,
  };
}
