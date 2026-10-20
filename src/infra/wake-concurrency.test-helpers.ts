import { expect, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

type WakeHandler = (
  request: HeartbeatWakeRequest,
  signal?: AbortSignal,
) => Promise<HeartbeatRunResult>;

export async function expectWakeHandlerReplacementConcurrency(params: {
  setHandler: (handler: WakeHandler) => void;
  requestTarget: (agentId: string) => void;
  getAbortSignal: (signal?: AbortSignal) => AbortSignal | undefined;
}): Promise<void> {
  const { setHandler, requestTarget, getAbortSignal } = params;
  vi.useFakeTimers();
  const finishOldWakeByAgent = new Map<string, () => void>();
  const finishNewWakeByAgent = new Map<string, () => void>();
  const oldWakeSignals: AbortSignal[] = [];
  let peakActiveWakeCount = 0;
  const oldHandler = vi.fn(async (request: HeartbeatWakeRequest, providedSignal?: AbortSignal) => {
    peakActiveWakeCount = Math.max(peakActiveWakeCount, getActiveGatewayRootWorkCount());
    // Resolve inside the handler: heartbeat uses async-local context, while
    // session-event receives the signal explicitly.
    const signal = getAbortSignal(providedSignal);
    if (signal) {
      oldWakeSignals.push(signal);
    }
    await new Promise<void>((resolve) => {
      finishOldWakeByAgent.set(request.agentId ?? "", resolve);
    });
    return { status: "ran" as const, durationMs: 1 };
  });
  setHandler(oldHandler);

  for (let index = 0; index < 4; index += 1) {
    requestTarget(`target-${index}`);
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(oldHandler).toHaveBeenCalledTimes(4);
  expect(getActiveGatewayRootWorkCount()).toBe(4);

  const newHandler = vi.fn(async (request: HeartbeatWakeRequest) => {
    peakActiveWakeCount = Math.max(peakActiveWakeCount, getActiveGatewayRootWorkCount());
    await new Promise<void>((resolve) => {
      finishNewWakeByAgent.set(request.agentId ?? "", resolve);
    });
    return { status: "ran" as const, durationMs: 1 };
  });
  setHandler(newHandler);
  requestTarget("target-0");
  for (let index = 4; index < 8; index += 1) {
    requestTarget(`target-${index}`);
  }

  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(oldWakeSignals).toHaveLength(4);
    expect(oldWakeSignals.every((signal) => signal.aborted)).toBe(false);
    expect(newHandler).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(4);
    for (const finishWake of finishOldWakeByAgent.values()) {
      finishWake();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(newHandler.mock.calls.map(([request]) => request.agentId)).toEqual([
      "target-0",
      "target-4",
      "target-5",
      "target-6",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(4);

    finishNewWakeByAgent.get("target-0")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(newHandler.mock.calls.map(([request]) => request.agentId)).toEqual([
      "target-0",
      "target-4",
      "target-5",
      "target-6",
      "target-7",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(4);
  } finally {
    for (let index = 0; index < 9; index += 1) {
      for (const finishWake of finishOldWakeByAgent.values()) {
        finishWake();
      }
      for (const finishWake of finishNewWakeByAgent.values()) {
        finishWake();
      }
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  expect(newHandler).toHaveBeenCalledTimes(5);
  expect(peakActiveWakeCount).toBe(4);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
}
