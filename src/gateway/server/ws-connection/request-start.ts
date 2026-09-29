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
};
type ControlConnection = { id: string; count: number };
type RequestStart = {
  grant: () => void;
  budget: StartBudget;
  frameBytes: number;
  controlConnection: ControlConnection | undefined;
};

const workBudget: StartBudget = {
  count: 0,
  bytes: 0,
  maxCount: 256,
  maxBytes: 50 * 1024 * 1024,
};
const controlBudget: StartBudget = { count: 0, bytes: 0, maxCount: 1024, maxBytes: 1024 * 1024 };
const pending: RequestStart[] = [];
const controlsByConnection = new Map<string, ControlConnection>();
const MAX_CONTROL_FRAME_BYTES = 4096;
const MAX_PENDING_CONTROLS_PER_CONNECTION = 16;
const MAX_STARTS_PER_TURN = 64;
const START_WORK_BUDGET_MS = 12;
let active = false;

async function grantStarts(first: RequestStart): Promise<void> {
  let current: RequestStart | undefined = first;
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
    current.grant();
    current = pending.shift();
    if (current) {
      current.budget.count--;
      current.budget.bytes -= current.frameBytes;
      if (current.controlConnection !== undefined) {
        current.controlConnection.count--;
        if (current.controlConnection.count === 0) {
          controlsByConnection.delete(current.controlConnection.id);
        }
      }
    }
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
    const controlConnection = control
      ? (controlsByConnection.get(connId) ?? { id: connId, count: 0 })
      : undefined;
    // One active scheduling task is separate from waiting capacity. All classes
    // share FIFO order and the same per-turn work budget.
    if (
      active &&
      (budget.count >= budget.maxCount ||
        budget.bytes + frameBytes > budget.maxBytes ||
        (controlConnection && controlConnection.count >= MAX_PENDING_CONTROLS_PER_CONNECTION))
    ) {
      return null;
    }
    const { promise, resolve: grant } = createDeferredCore();
    const start = { grant, budget, frameBytes, controlConnection };
    if (active) {
      budget.count++;
      budget.bytes += frameBytes;
      if (controlConnection) {
        controlConnection.count++;
        controlsByConnection.set(connId, controlConnection);
      }
      pending.push(start);
    } else {
      active = true;
      void grantStarts(start);
    }
    return promise;
  });
}
