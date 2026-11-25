import { expect } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { UpdateRunResult } from "./update-run-result.js";

export type PersistedUpdateCheckState = {
  lastCheckedAt?: string;
  lastCheckedChannel?: "stable" | "extended-stable" | "beta" | "dev";
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
};

export function commandSuccess(stdout = "") {
  return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" as const };
}

export function pauseAt<T>(
  entered: ReturnType<typeof createDeferred<void>>,
  result: ReturnType<typeof createDeferred<T>>,
) {
  return () => {
    entered.resolve(undefined);
    return result.promise;
  };
}

const idle = () => 0;
export const idleActiveWorkInspectors = (): GatewayActiveWorkInspectors => ({
  getQueueSize: idle,
  getPendingReplies: idle,
  getEmbeddedRuns: idle,
  getBackgroundExecSessions: idle,
  getCronRuns: idle,
  getAgentRuns: idle,
  getAcpRuns: idle,
  getMediaRuns: idle,
  getRootRequests: idle,
  getSessionAdmissions: idle,
  getSessionMutations: idle,
  getChatRuns: idle,
  getQueuedTurns: idle,
  getTerminalPersistence: idle,
  getTerminalSessions: idle,
});

export function updateResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return { status: "error", mode: "npm", steps: [], durationMs: 0, ...overrides };
}

export const expectNoCalls = (...mocks: unknown[]) =>
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());

export const matchingObject = (shape: Record<string, unknown>) => [expect.objectContaining(shape)];

export const containingObject = (shape: Record<string, unknown>) =>
  expect.arrayContaining(matchingObject(shape));
