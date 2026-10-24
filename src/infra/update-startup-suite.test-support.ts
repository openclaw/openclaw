import { expect } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { UpdateRunRecord } from "./update-run-record.js";
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

export function pauseAt<T>(
  entered: ReturnType<typeof createDeferred<void>>,
  result: ReturnType<typeof createDeferred<T>>,
) {
  return () => {
    entered.resolve(undefined);
    return result.promise;
  };
}

export function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
  const idle = () => 0;
  return {
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
  };
}

export function startedHandoff(
  overrides: Partial<{
    pid: number;
    command: string;
    logPath: string;
    handoffId: string;
    installRoot: string;
  }> = {},
) {
  return {
    status: "started" as const,
    pid: 12345,
    command: "openclaw update --yes --channel beta",
    logPath: "/tmp/openclaw-handoff.log",
    handoffId: "auto-handoff-id",
    installRoot: "/opt/openclaw",
    ...overrides,
  };
}

export function updateResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return { status: "error", mode: "npm", steps: [], durationMs: 0, ...overrides };
}

export async function recordedFailureReport(
  run: UpdateRunRecord,
  mode: UpdateRunResult["mode"] = "npm",
) {
  const { prepareUpdateFailureReport } = await import("./update-failure-report-prepare.js");
  return prepareUpdateFailureReport({
    attemptId: run.runId,
    recordedRun: run,
    result: updateResult({ mode, reason: run.reason ?? undefined }),
  });
}

export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export function expectIncludes(text: unknown, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}

export function matchingObject(shape: Record<string, unknown>) {
  return [expect.objectContaining(shape)];
}

export function containingObject(shape: Record<string, unknown>) {
  return expect.arrayContaining(matchingObject(shape));
}
