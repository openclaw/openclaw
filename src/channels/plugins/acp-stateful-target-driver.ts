import {
  ensureConfiguredAcpBindingReady,
  ensureConfiguredAcpBindingSession,
  resetAcpSessionInPlace,
} from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";
import type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetSessionResult,
} from "./stateful-target-drivers.js";

function toAcpStatefulBindingTargetDescriptor(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): StatefulBindingTargetDescriptor | null {
  const spec = resolveConfiguredAcpBindingSpecBySessionKey(params);
  if (!spec) {
    return null;
  }
  return {
    kind: "stateful",
    driverId: "acp",
    sessionKey: params.sessionKey,
    agentId: spec.agentId,
    ...(spec.label ? { label: spec.label } : {}),
  };
}

async function ensureAcpTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetReadyResult> {
  return await ensureConfiguredAcpBindingReady({
    cfg: params.cfg,
    configuredBinding: params.bindingResolution.configuredBinding,
  });
}

async function ensureAcpTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetSessionResult> {
  return await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec: params.bindingResolution.configuredBinding.spec,
  });
}

async function resetAcpTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
}): Promise<StatefulBindingTargetResetResult> {
  return await resetAcpSessionInPlace(params);
}

export const acpStatefulBindingTargetDriver: StatefulBindingTargetDriver = {
  id: "acp",
  ensureReady: ensureAcpTargetReady,
  ensureSession: ensureAcpTargetSession,
  resolveTargetBySessionKey: toAcpStatefulBindingTargetDescriptor,
  resetInPlace: resetAcpTargetInPlace,
};
