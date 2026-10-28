import { vi } from "vitest";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import type { RunExit } from "../../process/supervisor/types.js";
import type { Deferred } from "../../shared/deferred.js";

export function runExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

export function computerCapabilities(
  provider: ComputerUseCapabilityDescriptor["provider"],
  actions: ComputerUseCapabilityDescriptor["actions"] = ["screenshot", "left_click"],
): ComputerUseCapabilityDescriptor {
  return {
    contractVersion: 2,
    provider,
    actions,
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
}

export function observeSettlement(promise: Promise<unknown>) {
  const settled = vi.fn();
  return { settled, done: promise.then(settled, settled) };
}

export async function whileHeld<T>(gate: Deferred, check: () => T | Promise<T>) {
  try {
    return await check();
  } finally {
    gate.resolve();
  }
}
