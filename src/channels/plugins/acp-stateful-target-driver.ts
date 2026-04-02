import {
  ensureConfiguredAcpBindingReady,
  ensureConfiguredAcpBindingSession,
  resetAcpSessionInPlace,
} from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
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
  const meta = readAcpSessionEntry(params)?.acp;
  const metaAgentId = meta?.agent?.trim();
  if (metaAgentId) {
    return {
      kind: "stateful",
      driverId: "acp",
      sessionKey: params.sessionKey,
      agentId: metaAgentId,
    };
  }
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
  const configuredBinding = resolveConfiguredAcpBindingSpecFromRecord(
    params.bindingResolution.record,
  );
  if (!configuredBinding) {
    return {
      ok: false,
      error: "Configured ACP binding unavailable",
    };
  }
  return await ensureConfiguredAcpBindingReady({
    cfg: params.cfg,
    configuredBinding: {
      spec: configuredBinding,
      record: params.bindingResolution.record,
    },
  });
}

async function ensureAcpTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetSessionResult> {
  const spec = resolveConfiguredAcpBindingSpecFromRecord(params.bindingResolution.record);
  if (!spec) {
    return {
      ok: false,
      sessionKey: params.bindingResolution.statefulTarget.sessionKey,
      error: "Configured ACP binding unavailable",
    };
  }
  return await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec,
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
