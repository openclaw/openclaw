import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { SafeGatewayRestartRequestResult } from "../../infra/restart-coordinator.js";

type RestartPostCheckContext = {
  activationAccepted: boolean;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

export type RestartParams = {
  opts?: { json?: boolean };
  beforeServiceMutation?: () => void;
  repairLoadedService?: (ctx: {
    json: boolean;
    stdout: NodeJS.WritableStream;
    state: unknown;
    issues: unknown[];
  }) => Promise<unknown>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

export function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

export async function expectRestartError(
  promise: Promise<unknown>,
): Promise<Error & { hints?: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hints?: string[] };
  }
  throw new Error("expected restart to fail");
}

export type RestartHealthSnapshot = {
  healthy: boolean;
  staleGatewayPids: number[];
  runtime: { status?: string };
  portUsage: { port: number; status: string; listeners: []; hints: []; errors?: string[] };
  waitOutcome?: string;
  elapsedMs?: number;
};

export function createHealthyRestartSnapshot(): RestartHealthSnapshot {
  return {
    healthy: true,
    staleGatewayPids: [],
    runtime: { status: "running" },
    portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
  };
}

export function createGatewayLockIdentity(
  overrides: Partial<GatewayLockIdentity> = {},
): GatewayLockIdentity {
  return {
    pid: 4200,
    ownerId: "gateway-owner-old",
    createdAt: "2026-07-16T12:00:00.000Z",
    port: 18_789,
    ...overrides,
  };
}

export function createDeferredSafeRestartResult(): SafeGatewayRestartRequestResult {
  return {
    ok: true,
    status: "deferred",
    preflight: {
      safe: false,
      counts: {
        queueSize: 1,
        pendingReplies: 0,
        embeddedRuns: 0,
        cronRuns: 0,
        backgroundExecSessions: 0,
        rootRequests: 0,
        activeTasks: 0,
        totalActive: 1,
      },
      blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
      summary: "restart deferred: 1 queued or active operation(s)",
    },
    restart: {
      ok: true,
      pid: 123,
      signal: "SIGUSR2",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
      emitHooksQueued: false,
    },
  };
}

export async function runRestartPostCheck(params: RestartParams, activationAccepted: boolean) {
  await params.postRestartCheck?.({
    activationAccepted,
    json: Boolean(params.opts?.json),
    stdout: process.stdout,
    warnings: [],
    fail: failRestartCheck,
  });
}

function failRestartCheck(message: string, hints?: string[]) {
  const error: Error & { hints?: string[] } = new Error(message);
  error.hints = hints;
  throw error;
}
