import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";

type StatefulBindingTargetReadyResult = { ok: true } | { ok: false; error: string };
type StatefulBindingTargetSessionResult =
  | { ok: true; sessionKey: string }
  | { ok: false; sessionKey: string; error: string };
export type StatefulBindingTargetResetResult =
  | { ok: true; sessionKey?: string; sessionId?: string; storePath?: string }
  | { ok: false; skipped?: boolean; error?: string };

/** Driver contract for lifecycle operations on one stateful target family. */
export type StatefulBindingTargetDriver = {
  id: string;
  ensureReady: (params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetReadyResult>;
  ensureSession: (params: {
    cfg: OpenClawConfig;
    bindingResolution: ConfiguredBindingResolution;
  }) => Promise<StatefulBindingTargetSessionResult>;
  resolveTargetBySessionKey?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  }) => Promise<StatefulBindingTargetDescriptor | null> | StatefulBindingTargetDescriptor | null;
  resetInPlace?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    bindingTarget: StatefulBindingTargetDescriptor;
    reason: "new" | "reset";
    commandSource?: string;
  }) => Promise<StatefulBindingTargetResetResult>;
};

const registeredStatefulBindingTargetDrivers = resolveGlobalMap<
  string,
  StatefulBindingTargetDriver
>(Symbol.for("openclaw.statefulBindingTargetDrivers"), "plugin-registry");

export function registerStatefulBindingTargetDriver(
  driver: StatefulBindingTargetDriver,
): () => void {
  const id = driver.id.trim();
  if (!id) {
    throw new Error("Stateful binding target driver id is required");
  }
  const normalized = { ...driver, id };
  const existing = registeredStatefulBindingTargetDrivers.get(id);
  if (existing) {
    // Builtins and tests may register through multiple load paths. First writer
    // wins so process-local sessions keep using the same driver instance.
    return () => {};
  }
  registeredStatefulBindingTargetDrivers.set(id, normalized);
  return () => {
    // Cleanup owns only this registration; a later replacement must survive stale disposal.
    if (registeredStatefulBindingTargetDrivers.get(id) === normalized) {
      registeredStatefulBindingTargetDrivers.delete(id);
    }
  };
}

export function getStatefulBindingTargetDriver(id: string): StatefulBindingTargetDriver | null {
  return registeredStatefulBindingTargetDrivers.get(id.trim()) ?? null;
}

export async function resolveStatefulBindingTargetBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): Promise<{
  driver: StatefulBindingTargetDriver;
  bindingTarget: StatefulBindingTargetDescriptor;
} | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  // Session keys are globally opaque to callers. Ask each registered driver so
  // channel-specific encodings stay private to their owner.
  // Freeze the candidates before awaiting drivers that may change the registry.
  const drivers = [...registeredStatefulBindingTargetDrivers.values()];
  for (const driver of drivers) {
    const bindingTarget = await driver.resolveTargetBySessionKey?.({
      cfg: params.cfg,
      sessionKey,
      agentId: params.agentId,
    });
    if (bindingTarget && getStatefulBindingTargetDriver(driver.id) === driver) {
      return {
        driver,
        bindingTarget,
      };
    }
  }
  return null;
}
