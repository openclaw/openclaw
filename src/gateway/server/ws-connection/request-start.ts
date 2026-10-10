import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
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
  reject: (error: Error) => void;
  expiresAt: number;
  preparation: boolean;
  independentRead: boolean;
  settled: Promise<void>;
  signal?: AbortSignal;
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
const MAX_CONCURRENT_PREPARATIONS = 4;
const MAX_QUEUE_WAIT_MS = 30_000;
let preparations = 0;
let notifyQueueChanged: (() => void) | undefined;
let active = false;

export class GatewayRequestStartTimeoutError extends Error {
  constructor() {
    super("The server could not start the request within 30 seconds. Please try again.");
  }
}

async function grantStarts(): Promise<void> {
  let turnStartedAt = 0;
  let turnStarts = MAX_STARTS_PER_TURN;
  while (pending.length > 0) {
    const now = performance.now();
    const blockedConnections = new Set<string>();
    const index = pending.findIndex((work) => {
      if (work.signal?.aborted || now >= work.expiresAt) {
        return true;
      }
      if (
        (work.preparation && preparations >= MAX_CONCURRENT_PREPARATIONS) ||
        (!work.independentRead && blockedConnections.has(work.connection.id))
      ) {
        blockedConnections.add(work.connection.id);
        return false;
      }
      return true;
    });
    if (index === -1) {
      const changed = createDeferredCore();
      notifyQueueChanged = changed.resolve;
      const timeout = setTimeout(
        changed.resolve,
        Math.max(0, pending[0]!.expiresAt - performance.now()),
      );
      await racePromiseWithAbortSignal(changed.promise, pending[0]!.signal).catch(() => {});
      clearTimeout(timeout);
      notifyQueueChanged = undefined;
      continue;
    }
    const current = pending.splice(index, 1)[0]!;
    current.budget.count--;
    current.budget.bytes -= current.frameBytes;
    current.connection.count--;
    if (current.connection.count === 0) {
      current.budget.connections.delete(current.connection.id);
    }
    if (
      current.preparation ||
      turnStarts >= MAX_STARTS_PER_TURN ||
      performance.now() - turnStartedAt >= START_WORK_BUDGET_MS
    ) {
      await nextTurn();
      turnStartedAt = performance.now();
      turnStarts = 0;
    }
    turnStarts++;
    if (performance.now() >= current.expiresAt) {
      current.reject(new GatewayRequestStartTimeoutError());
      continue;
    }
    if (current.preparation && !current.signal?.aborted) {
      preparations++;
      void current.settled.then(() => {
        preparations--;
        notifyQueueChanged?.();
      });
    }
    current.grant();
    // Count ready caller continuations, without inheriting their root admission.
    await new Promise<void>(queueMicrotask);
  }
  active = false;
}

/** Park saturated preparations; preserve connection order except for independent reads. */
export function scheduleGatewayRequestStart(
  frameBytes: number,
  request: Pick<RequestFrame, "method" | "params">,
  connId: string,
  settled: Promise<void>,
  signal?: AbortSignal,
): Promise<void> | null {
  return runOutsideGatewayRootWorkAdmission(() => {
    // Handshakes bypass this queue. Yield before each snapshot/replay start so
    // ready upgrade/hello I/O runs before another preparation resumes on the main thread.
    const preparation =
      request.method === "sessions.subscribe" ||
      request.method === "models.list" ||
      (request.method === "sessions.messages.subscribe" &&
        asOptionalRecord(request.params)?.includeApprovals === true);
    const independentRead = request.method === "chat.history" || request.method === "sessions.list";
    const control =
      frameBytes <= MAX_CONTROL_FRAME_BYTES &&
      (request.method === "sessions.messages.unsubscribe" ||
        (request.method === "sessions.messages.subscribe" &&
          asOptionalRecord(request.params)?.includeApprovals !== true));
    const budget = control ? controlBudget : workBudget;
    const connection = budget.connections.get(connId);
    // Parked preparations still consume waiting capacity, never a runnable start.
    if (
      budget.count >= budget.maxCount ||
      budget.bytes + frameBytes > budget.maxBytes ||
      (connection && connection.count >= budget.maxConnectionCount)
    ) {
      return null;
    }
    const { promise, resolve: grant, reject } = createDeferredCore();
    const queuedConnection = connection ?? { id: connId, count: 0 };
    budget.count++;
    budget.bytes += frameBytes;
    queuedConnection.count++;
    budget.connections.set(connId, queuedConnection);
    pending.push({
      grant,
      reject,
      expiresAt: performance.now() + MAX_QUEUE_WAIT_MS,
      preparation,
      independentRead,
      settled,
      signal,
      budget,
      frameBytes,
      connection: queuedConnection,
    });
    if (!active) {
      active = true;
      void grantStarts();
    } else {
      notifyQueueChanged?.();
    }
    return promise;
  });
}
