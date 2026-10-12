import type { NativeWorkerFailure } from "../../infra/worker-native-error.js";

export const SPAWN_BROKER_STARTUP_TIMEOUT_MS = 15_000;

const monotonic = process.hrtime.bigint.bind(process.hrtime);

/** Native startup shares the host's monotonic clock across Node contexts. */
export function spawnBrokerStartupNowMs(): number {
  return Number(monotonic() / 1_000_000n);
}

export type BrokerBootstrap = {
  type: "bootstrap";
  nativeResource?: { endpoint: string; secret: string; generation: number };
};

/** The domain decoder, not a transport adapter, restores this original cleanup payload. */
export class BrokerNativeResourceCloseError extends Error {
  constructor(readonly payload: unknown) {
    super("Native resource cleanup failed");
    this.name = "BrokerNativeResourceCloseError";
  }
}

/** Captured by the live spawn owner before its submitting Worker can start. */
export type BrokerResourceAttachment = {
  endpoint: string;
  secret: string;
  generation: number;
  /** Same-host monotonic milliseconds, scoped to this native source's startup. */
  startupDeadline?: number;
  id: number;
  moduleUrl: string;
  input?: unknown;
  ownerPort: boolean;
};

export type BrokerResourceRequest =
  | { type: "resource-attach"; attachment: BrokerResourceAttachment }
  | { type: "resource-seal" }
  | { type: "resource-target"; id: number; value: unknown }
  | { type: "resource-owner"; id: number; sequence: number; value: unknown }
  | { type: "resource-close"; id: number; requestId: number }
  | { type: "resource-release"; id: number };

export type BrokerResourceResponse =
  | { type: "resource-ready"; id: number; pid: number; generation: number }
  | { type: "resource-created"; id: number }
  | { type: "resource-target"; id: number; value: unknown }
  | { type: "resource-owner"; id: number; sequence: number; value: unknown }
  | { type: "resource-owner-received"; id: number; sequence: number }
  | { type: "resource-owner-rejected"; id: number; sequence: number; error: NativeWorkerFailure }
  | { type: "resource-closed"; id: number; requestId: number }
  | {
      type: "resource-close-error";
      id: number;
      requestId: number;
      error: unknown;
      resourceError: true;
    }
  | {
      type: "resource-close-error";
      id: number;
      requestId: number;
      error: NativeWorkerFailure;
      resourceError: false;
    }
  | { type: "resource-failed"; id: number; error: NativeWorkerFailure };
