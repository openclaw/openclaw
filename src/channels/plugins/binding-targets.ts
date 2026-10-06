import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetResetResult,
} from "./binding-types.js";

/**
 * Ensures the stateful target driver for a configured binding is ready to receive traffic.
 */
export async function ensureConfiguredBindingTargetReady(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.bindingResolution) {
    return { ok: true };
  }
  const driverId = params.bindingResolution.statefulTarget.driverId;
  if (driverId.trim() !== "acp") {
    return {
      ok: false,
      error: `Configured binding target driver unavailable: ${driverId}`,
    };
  }
  const { ensureConfiguredAcpBindingTargetReady } = await import("./acp-stateful-target-driver.js");
  try {
    params.assertActive?.();
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
  return await ensureConfiguredAcpBindingTargetReady({
    ...(params.assertActive ? { assertActive: params.assertActive } : {}),
    cfg: params.cfg,
    bindingResolution: params.bindingResolution,
  });
}

/**
 * Resets a stateful configured binding target in place when its driver supports reset.
 */
export async function resetConfiguredBindingTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<StatefulBindingTargetResetResult> {
  const { resolveAcpBindingTargetBySessionKey, resetConfiguredAcpBindingTargetInPlace } =
    await import("./acp-stateful-target-driver.js");
  const bindingTarget = await resolveAcpBindingTargetBySessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!bindingTarget) {
    return {
      ok: false,
      skipped: true,
    };
  }
  return await resetConfiguredAcpBindingTargetInPlace({
    ...params,
    bindingTarget,
  });
}
