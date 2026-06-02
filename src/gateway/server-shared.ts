import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";

export type DedupeEntry = {
  /** Timestamp used by maintenance pruning and active-run retention checks. */
  ts: number;
  /** Cached protocol success bit for completed idempotent requests. */
  ok: boolean;
  /** Cached response payload returned for duplicate successful requests. */
  payload?: unknown;
  /** Cached protocol error returned for duplicate failed requests. */
  error?: ErrorShape;
};
