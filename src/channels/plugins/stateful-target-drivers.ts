import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";

/** Readiness result returned before routing traffic into a stateful target. */
export type StatefulBindingTargetReadyResult = { ok: true } | { ok: false; error: string };
/** Session result returned after creating or confirming a routed stateful target session. */
export type StatefulBindingTargetSessionResult =
  | { ok: true; sessionKey: string }
  | { ok: false; sessionKey: string; error: string };
/** Reset result for drivers that can reset an existing stateful target in place. */
export type StatefulBindingTargetResetResult =
  | { ok: true }
  | { ok: false; skipped?: boolean; error?: string };

/** Driver contract for stateful binding targets such as ACP-backed sessions. */
export type StatefulBindingTargetDriver = {
  id: string;
  /** Validates external state before route rewrite sends traffic to the target. */
  ensureReady: (params: {
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetReadyResult>;
  /** Creates or confirms the live session represented by the configured binding. */
  ensureSession: (params: {
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetSessionResult>;
  /** Reverse-resolves a session key for reset/status paths that start from session identity. */
  resolveTargetBySessionKey?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => StatefulBindingTargetDescriptor | null;
  /** Resets a live target without changing the configured binding record. */
  resetInPlace?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    bindingTarget: StatefulBindingTargetDescriptor;
    reason: "new" | "reset";
    commandSource?: string;
  }) => Promise<StatefulBindingTargetResetResult>;
};

const registeredStatefulBindingTargetDrivers = new Map<string, StatefulBindingTargetDriver>();

function listStatefulBindingTargetDrivers(): StatefulBindingTargetDriver[] {
  return [...registeredStatefulBindingTargetDrivers.values()];
}

/** Registers a stateful binding target driver if its id has not been registered yet. */
export function registerStatefulBindingTargetDriver(driver: StatefulBindingTargetDriver): void {
  const id = driver.id.trim();
  if (!id) {
    throw new Error("Stateful binding target driver id is required");
  }
  const normalized = { ...driver, id };
  const existing = registeredStatefulBindingTargetDrivers.get(id);
  if (existing) {
    return;
  }
  registeredStatefulBindingTargetDrivers.set(id, normalized);
}

/** Unregisters a stateful binding target driver, mainly for tests and lifecycle cleanup. */
export function unregisterStatefulBindingTargetDriver(id: string): void {
  registeredStatefulBindingTargetDrivers.delete(id.trim());
}

/** Looks up a registered stateful binding target driver by id. */
export function getStatefulBindingTargetDriver(id: string): StatefulBindingTargetDriver | null {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return null;
  }
  return registeredStatefulBindingTargetDrivers.get(normalizedId) ?? null;
}

/** Finds the driver and target descriptor that own a stateful target session key. */
export function resolveStatefulBindingTargetBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): { driver: StatefulBindingTargetDriver; bindingTarget: StatefulBindingTargetDescriptor } | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  for (const driver of listStatefulBindingTargetDrivers()) {
    const bindingTarget = driver.resolveTargetBySessionKey?.({
      cfg: params.cfg,
      sessionKey,
    });
    if (bindingTarget) {
      return {
        driver,
        bindingTarget,
      };
    }
  }
  return null;
}
