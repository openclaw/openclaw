import { expect } from "vitest";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { SafeGatewayRestartRequestResult } from "../../infra/restart-coordinator.js";

export function createGatewayProcessExpectations(
  listeners: typeof import("../../infra/gateway-processes.js").findVerifiedGatewayListenerPidsOnPortSync,
  signalPid: typeof import("../../infra/gateway-processes.js").signalVerifiedGatewayPidSync,
) {
  return {
    listeners(port: number, env?: NodeJS.ProcessEnv) {
      expect(listeners).toHaveBeenCalledWith(port, { env });
    },
    signal(pid: number, signal: "SIGTERM" | "SIGUSR1", port: number, env?: NodeJS.ProcessEnv) {
      expect(signalPid).toHaveBeenCalledWith(pid, signal, { env, port });
    },
    noSignal(pid: number, signal: "SIGTERM" | "SIGUSR1", port: number, env?: NodeJS.ProcessEnv) {
      expect(signalPid).not.toHaveBeenCalledWith(pid, signal, { env, port });
    },
  };
}

type CoreRestartParams = Parameters<typeof import("./lifecycle-core.js").runServiceRestart>[0];
type RestartPostCheckContext = Parameters<NonNullable<CoreRestartParams["postRestartCheck"]>>[0];
export type RestartParams = Pick<CoreRestartParams, "opts" | "beforeServiceMutation"> & {
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
  return promise.then(
    () => {
      throw new Error("expected restart to fail");
    },
    (error: unknown) => error as Error & { hints?: string[] },
  );
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

type SafeRestartResponse = Pick<SafeGatewayRestartRequestResult, "status"> & {
  preflight: Pick<SafeGatewayRestartRequestResult["preflight"], "blockers" | "summary">;
  restart: Pick<SafeGatewayRestartRequestResult["restart"], "pid">;
};

export function createDeferredSafeRestartResult(): SafeRestartResponse {
  return {
    status: "deferred",
    preflight: {
      blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
      summary: "restart deferred: 1 queued or active operation(s)",
    },
    restart: { pid: 123 },
  };
}

export async function runRestartPostCheck(params: RestartParams, activationAccepted: boolean) {
  await params.postRestartCheck?.({
    activationAccepted,
    json: Boolean(params.opts?.json),
    stdout: process.stdout,
    warnings: [],
    fail: (message, hints) => {
      throw Object.assign(new Error(message), { hints });
    },
  });
}
