import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import {
  ensureStatefulTargetBuiltinsRegistered,
  isStatefulTargetBuiltinDriverId,
} from "./stateful-target-builtins.js";
import {
  getStatefulBindingTargetDriver,
  resolveStatefulBindingTargetBySessionKey,
} from "./stateful-target-drivers.js";

export async function ensureConfiguredBindingTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.bindingResolution) {
    return { ok: true };
  }
  const driverId = params.bindingResolution.statefulTarget.driverId;
  let driver = getStatefulBindingTargetDriver(driverId);
  if (!driver && isStatefulTargetBuiltinDriverId(driverId)) {
    // Built-in drivers are registered lazily so callers that do not use
    // configured bindings avoid loading their target runtime.
    await ensureStatefulTargetBuiltinsRegistered();
    driver = getStatefulBindingTargetDriver(driverId);
  }
  if (!driver) {
    return {
      ok: false,
      error: `Configured binding target driver unavailable: ${driverId}`,
    };
  }
  return await driver.ensureReady({
    cfg: params.cfg,
    bindingResolution: params.bindingResolution,
  });
}

/** Reset an existing stateful binding target in place when its driver supports it. */
export async function resetConfiguredBindingTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<{ ok: true } | { ok: false; skipped?: boolean; error?: string }> {
  let resolved = resolveStatefulBindingTargetBySessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!resolved) {
    // Session-key reset can arrive before built-in drivers are loaded; retry
    // once after registration before treating the target as unknown.
    await ensureStatefulTargetBuiltinsRegistered();
    resolved = resolveStatefulBindingTargetBySessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
  }
  if (!resolved?.driver.resetInPlace) {
    // Missing reset support is a non-error skip so command handlers can fall
    // back to creating a fresh session when appropriate.
    return {
      ok: false,
      skipped: true,
    };
  }
  return await resolved.driver.resetInPlace({
    ...params,
    bindingTarget: resolved.bindingTarget,
  });
}

/** Ensure the stateful target session exists for a resolved configured binding. */
export async function ensureConfiguredBindingTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; sessionKey: string; error: string }> {
  const driverId = params.bindingResolution.statefulTarget.driverId;
  let driver = getStatefulBindingTargetDriver(driverId);
  if (!driver && isStatefulTargetBuiltinDriverId(driverId)) {
    // Keep readiness and session creation on the same lazy built-in driver path.
    await ensureStatefulTargetBuiltinsRegistered();
    driver = getStatefulBindingTargetDriver(driverId);
  }
  if (!driver) {
    return {
      ok: false,
      sessionKey: params.bindingResolution.statefulTarget.sessionKey,
      error: `Configured binding target driver unavailable: ${driverId}`,
    };
  }
  return await driver.ensureSession({
    cfg: params.cfg,
    bindingResolution: params.bindingResolution,
  });
}
