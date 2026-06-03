import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";

export type StatefulBindingTargetReadyResult = { ok: true } | { ok: false; error: string };
export type StatefulBindingTargetSessionResult =
  | { ok: true; sessionKey: string }
  | { ok: false; sessionKey: string; error: string };
export type StatefulBindingTargetResetResult =
  | { ok: true }
  | { ok: false; skipped?: boolean; error?: string };

/** Driver contract for creating, locating, and resetting stateful configured binding targets. */
export type StatefulBindingTargetDriver = {
  id: string;
  /** Validate prerequisites before a routed turn tries to use the target session. */
  ensureReady: (params: {
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetReadyResult>;
  /** Create or locate the backing session for a resolved configured binding. */
  ensureSession: (params: {
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetSessionResult>;
  /** Parse a session key back into this driver's target descriptor when possible. */
  resolveTargetBySessionKey?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => StatefulBindingTargetDescriptor | null;
  /** Reset an existing target without replacing its configured binding record. */
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

export function registerStatefulBindingTargetDriver(driver: StatefulBindingTargetDriver): void {
  const id = driver.id.trim();
  if (!id) {
    throw new Error("Stateful binding target driver id is required");
  }
  const normalized = { ...driver, id };
  const existing = registeredStatefulBindingTargetDrivers.get(id);
  if (existing) {
    // Registration is idempotent so built-in lazy loading and test setup can
    // call through the same path without replacing an active driver instance.
    return;
  }
  registeredStatefulBindingTargetDrivers.set(id, normalized);
}

export function unregisterStatefulBindingTargetDriver(id: string): void {
  registeredStatefulBindingTargetDrivers.delete(id.trim());
}

export function getStatefulBindingTargetDriver(id: string): StatefulBindingTargetDriver | null {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return null;
  }
  return registeredStatefulBindingTargetDrivers.get(normalizedId) ?? null;
}

export function resolveStatefulBindingTargetBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): { driver: StatefulBindingTargetDriver; bindingTarget: StatefulBindingTargetDescriptor } | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  // Drivers own session-key parsing. Probe registered drivers in registration
  // order and return the first target that recognizes the key.
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
