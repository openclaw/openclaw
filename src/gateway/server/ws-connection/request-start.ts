import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/index.js";
import { runOutsideGatewayRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";

type StartBudget = {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  maxConnectionCount: number;
  connections: Map<string, StartConnection>;
};
type StartConnection = { id: string; count: number };
type RequestStart = {
  grant: () => void;
  budget: StartBudget;
  frameBytes: number;
  connection: StartConnection;
};

const workBudget: StartBudget = {
  count: 0,
  bytes: 0,
  maxCount: 1024,
  maxBytes: 50 * 1024 * 1024,
  maxConnectionCount: 256,
  connections: new Map(),
};
const controlBudget: StartBudget = {
  count: 0,
  bytes: 0,
  maxCount: 1024,
  maxBytes: 1024 * 1024,
  maxConnectionCount: 16,
  connections: new Map(),
};
const pending: RequestStart[] = [];
const MAX_CONTROL_FRAME_BYTES = 4096;
const MAX_STARTS_PER_TURN = 64;
const START_WORK_BUDGET_MS = 12;
let active = false;

async function grantStarts(first: () => void): Promise<void> {
  let current: (() => void) | undefined = first;
  let turnStartedAt = 0;
  let turnStarts = MAX_STARTS_PER_TURN;
  while (current) {
    // Include ready caller continuations in the work budget without awaiting
    // an unresolved RPC or inheriting its root admission.
    await new Promise<void>(queueMicrotask);
    if (
      turnStarts >= MAX_STARTS_PER_TURN ||
      performance.now() - turnStartedAt >= START_WORK_BUDGET_MS
    ) {
      await nextTurn();
      turnStartedAt = performance.now();
      turnStarts = 0;
    }
    turnStarts++;
    current();
    const next = pending.shift();
    if (next) {
      next.budget.count--;
      next.budget.bytes -= next.frameBytes;
      next.connection.count--;
      if (next.connection.count === 0) {
        next.budget.connections.delete(next.connection.id);
      }
    }
    current = next?.grant;
  }
  active = false;
}

/** Grants operator router-start permission, or null when its waiting budget is exhausted. */
export function scheduleGatewayRequestStart(
  frameBytes: number,
  request: Pick<RequestFrame, "method" | "params">,
  connId: string,
): Promise<void> | null {
  return runOutsideGatewayRootWorkAdmission(() => {
    // Approval replay and roster snapshots retain the ordinary work budget.
    const control =
      frameBytes <= MAX_CONTROL_FRAME_BYTES &&
      (request.method === "sessions.messages.unsubscribe" ||
        (request.method === "sessions.messages.subscribe" &&
          asOptionalRecord(request.params)?.includeApprovals !== true));
    const budget = control ? controlBudget : workBudget;
    const connection = active ? budget.connections.get(connId) : undefined;
    // One active scheduling task is separate from waiting capacity. All classes
    // share FIFO order and the same per-turn work budget.
    if (
      active &&
      (budget.count >= budget.maxCount ||
        budget.bytes + frameBytes > budget.maxBytes ||
        (connection && connection.count >= budget.maxConnectionCount))
    ) {
      return null;
    }
    const { promise, resolve: grant } = createDeferredCore();
    if (active) {
      const queuedConnection = connection ?? { id: connId, count: 0 };
      budget.count++;
      budget.bytes += frameBytes;
      queuedConnection.count++;
      if (!connection) {
        budget.connections.set(connId, queuedConnection);
      }
      pending.push({ grant, budget, frameBytes, connection: queuedConnection });
    } else {
      active = true;
      void grantStarts(grant);
    }
    return promise;
  });
}
