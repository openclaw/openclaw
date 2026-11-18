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
  /** A long-lived subscription that its owner retires when restart drain begins. */
  subscription?: true;
  retiredByReset?: true;
  releaseObservers?: Set<(reason: "settled" | "reset") => void>;
};

export const currentRootWork = new AsyncContext<GatewayRootWorkAdmission>(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
);
export const reloadWaitingRoots = new AsyncContext<ReadonlySet<GatewayRootWorkAdmission>>(
  Symbol("gatewayReloadWaitingRoots"),
);
export const subscriptionRootWork = new AsyncContext<true>(Symbol("gatewaySubscriptionRootWork"));

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

function isActiveRootWork(
  admission: GatewayRootWorkAdmission,
  opts: { excludeCurrent?: boolean } | undefined,
): boolean {
  // An open subscription is not pending work until drain retires it; its close then is.
  if (admission.subscription && GATEWAY_WORK_ADMISSION_STATE.restartDrainReason === undefined) {
    return false;
  }
  return (
    opts?.excludeCurrent !== true ||
    (admission !== currentRootWork.getStore() && !reloadWaitingRoots.getStore()?.has(admission))
  );
}

/** Active root requests/ticks, optionally excluding the caller running prepare. */
export function getActiveGatewayRootWorkCount(opts?: { excludeCurrent?: boolean }): number {
  let count = 0;
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    if (isActiveRootWork(admission, opts)) {
      count += 1;
    }
  }
  return count;
}

/** Bounded, deterministic root-owner inventory for shutdown diagnostics. */
export function getActiveGatewayRootWorkHolders(opts?: { excludeCurrent?: boolean }): string[] {
  const counts = new Map<string, number>();
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    if (!isActiveRootWork(admission, opts)) {
      continue;
    }
    counts.set(admission.origin, (counts.get(admission.origin) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([origin, count]) => (count > 1 ? `${origin} (${count})` : origin));
}
