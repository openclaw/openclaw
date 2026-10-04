import { resolveAcpSessionTarget } from "../../acp/control-plane/manager.utils.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
import { performGatewaySessionReset } from "../../gateway/session-reset-service.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { StatefulBindingTargetDriver } from "./stateful-target-drivers.js";

export const acpStatefulBindingTargetDriver: StatefulBindingTargetDriver = {
  id: "acp",
  async resolveTargetBySessionKey(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
      return null;
    }
    const target = resolveAcpSessionTarget(params);
    const stored = await readAcpSessionEntryAsync({ cfg: params.cfg, ...target });
    if (stored?.acp) {
      return {
        kind: "stateful",
        driverId: "acp",
        ...target,
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
  },
  async ensureReady(params) {
    const configuredBinding = resolveConfiguredAcpBindingSpecFromRecord(
      params.bindingResolution.record,
    );
    if (!configuredBinding) {
      return {
        ok: false,
        error: "Configured ACP binding unavailable",
      };
    }
    const result = await ensureConfiguredAcpBindingSession({
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      cfg: params.cfg,
      spec: configuredBinding,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "unknown error" };
  },
  async resetInPlace(params) {
    const stored = await readAcpSessionEntryAsync({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.bindingTarget.agentId,
    });
    if (stored?.storeReadFailed) {
      return { ok: false, error: "Session metadata is unavailable; retry after storage is ready." };
    }
    if (stored?.entry?.incognito === true) {
      return { ok: false, error: "Incognito sessions cannot reset in place." };
    }
    const result = await performGatewaySessionReset({
      key: params.sessionKey,
      agentId: params.bindingTarget.agentId,
      operatorRoleActor: { kind: "system" },
      reason: params.reason,
      commandSource: params.commandSource ?? "stateful-target:acp-reset-in-place",
      armSessionDiffBaselineCapture: true,
    });
    if (result.ok) {
      if ("incognitoDeleted" in result) {
        return { ok: true, sessionKey: result.key, storePath: result.storePath };
      }
      return {
        ok: true,
        sessionKey: result.key,
        sessionId: result.entry.sessionId,
        storePath: result.storePath,
      };
    }
    return {
      ok: false,
      error: result.error.message,
    };
  },
};
