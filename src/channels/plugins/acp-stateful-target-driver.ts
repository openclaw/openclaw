import {
  ensureConfiguredAcpBindingReady,
  ensureConfiguredAcpBindingSession,
} from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { performGatewaySessionReset } from "./acp-stateful-target-reset.runtime.js";
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

/**
 * Resolves an ACP session key back to the stateful target descriptor used by
 * native commands. Runtime metadata wins, configured binding records provide
 * labels, and ACP-shaped keys remain resettable after metadata is cleared.
 */
function toAcpStatefulBindingTargetDescriptor(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): StatefulBindingTargetDescriptor | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const meta = readAcpSessionEntry({
    ...params,
    sessionKey,
  })?.acp;
  const metaAgentId = meta?.agent?.trim();
  if (metaAgentId) {
    return {
      kind: "stateful",
      driverId: "acp",
      sessionKey,
      agentId: metaAgentId,
    };
  }
  const spec = resolveConfiguredAcpBindingSpecBySessionKey({
    ...params,
    sessionKey,
  });
  if (!spec) {
    if (!isAcpSessionKey(sessionKey)) {
      return null;
    }
    // Bound ACP sessions can intentionally clear their ACP metadata after a
    // reset. The native /reset path still needs to recognize the ACP session
    // key as resettable while that metadata is absent.
    return {
      kind: "stateful",
      driverId: "acp",
      sessionKey,
      agentId: resolveAgentIdFromSessionKey(sessionKey),
    };
  }
  return {
    kind: "stateful",
    driverId: "acp",
    sessionKey,
    agentId: spec.agentId,
    ...(spec.label ? { label: spec.label } : {}),
  };
}

/**
 * Validates that the configured ACP binding is available before a stateful
 * target can accept work. The lifecycle helper owns process startup and auth
 * recovery; the driver only adapts the configured binding record.
 */
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

/**
 * Opens or reuses the ACP session for a configured binding target. The session
 * helper remains the single owner for key allocation and persistent metadata.
 */
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

/**
 * Resets the resolved ACP session without re-resolving channel bindings. Native
 * command callers have already selected the target; gateway reset remains the
 * authority for replacing the session entry in place.
 */
async function resetAcpTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  bindingTarget: StatefulBindingTargetDescriptor;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<StatefulBindingTargetResetResult> {
  const result = await performGatewaySessionReset({
    key: params.sessionKey,
    reason: params.reason,
    commandSource: params.commandSource ?? "stateful-target:acp-reset-in-place",
  });
  if (result.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    error: result.error.message,
  };
}

export const acpStatefulBindingTargetDriver: StatefulBindingTargetDriver = {
  id: "acp",
  ensureReady: ensureAcpTargetReady,
  ensureSession: ensureAcpTargetSession,
  resolveTargetBySessionKey: toAcpStatefulBindingTargetDescriptor,
  resetInPlace: resetAcpTargetInPlace,
};
