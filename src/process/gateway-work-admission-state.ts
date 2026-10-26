// Shared admission state; policy and logging stay in gateway-work-admission.ts.
import { setMaxListeners } from "node:events";
import type { GatewaySuspension } from "../../packages/gateway-protocol/src/schema/gateway-suspend.js";
import { AsyncContext } from "../shared/async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GatewaySuspendAdmissionPhase = GatewaySuspension["phase"];

export type GatewayShutdownTrigger =
  | "SIGTERM"
  | "SIGINT"
  | "SIGUSR2"
  | "hosted Gateway stop"
  | "process exit"
  | "host lifeline closed";
export type GatewayDrainReason =
  | "restart"
  | `${"stop" | "restart"} (${GatewayShutdownTrigger}${"" | `: ${string}`})`;

export type GatewayRootWorkAdmission = {
  origin: string;
  references: number;
  released: boolean;
  retiredByReset?: true;
  releaseObservers?: Set<(reason: "settled" | "reset") => void>;
};

export const currentRootWork = new AsyncContext<GatewayRootWorkAdmission>(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
);
export const reloadWaitingRoots = new AsyncContext<ReadonlySet<GatewayRootWorkAdmission>>(
  Symbol("gatewayReloadWaitingRoots"),
);

export function createShutdownCleanupController(): AbortController {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  return controller;
}

export const GATEWAY_WORK_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
  (): {
    restartDrainReason: GatewayDrainReason | undefined;
    restartDrainController: AbortController;
    shutdownCleanupController: AbortController;
    restartSignalPending: boolean;
    restartSignalGeneration: number;
    suspendPhase: GatewaySuspendAdmissionPhase;
    suspendGeneration: number;
    suspendAttribution?: string;
    suspendInvalidated?: () => void;
    activeRootWork: Set<GatewayRootWorkAdmission>;
    suspendOpenWaiters: Set<() => void>;
    suspendListeners: Set<(phase: GatewaySuspendAdmissionPhase) => void>;
  } => ({
    restartDrainReason: undefined,
    restartDrainController: new AbortController(),
    shutdownCleanupController: createShutdownCleanupController(),
    restartSignalPending: false,
    restartSignalGeneration: 0,
    suspendPhase: "accepting",
    suspendGeneration: 0,
    activeRootWork: new Set(),
    suspendOpenWaiters: new Set(),
    suspendListeners: new Set(),
  }),
);

/** Active root requests/ticks, optionally excluding the caller running prepare. */
export function getActiveGatewayRootWorkCount(opts?: { excludeCurrent?: boolean }): number {
  const active = GATEWAY_WORK_ADMISSION_STATE.activeRootWork;
  if (!opts?.excludeCurrent) {
    return active.size;
  }
  const excluded = new Set(reloadWaitingRoots.getStore());
  const current = currentRootWork.getStore();
  if (current) {
    excluded.add(current);
  }
  return active.size - [...excluded].filter((root) => active.has(root)).length;
}

/** Bounded, deterministic root-owner inventory for shutdown diagnostics. */
export function getActiveGatewayRootWorkHolders(opts?: { excludeCurrent?: boolean }): string[] {
  const current = currentRootWork.getStore();
  const counts = new Map<string, number>();
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    if (
      opts?.excludeCurrent === true &&
      (admission === current || reloadWaitingRoots.getStore()?.has(admission))
    ) {
      continue;
    }
    counts.set(admission.origin, (counts.get(admission.origin) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([origin, count]) => (count > 1 ? `${origin} (${count})` : origin));
}
