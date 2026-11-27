import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { resolveCanonicalMainSessionKey } from "../../../config/sessions/main-session-key.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { hashCronJobDefinition } from "../../../cron/definition-hash.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { isCronOperatorSourceParent } from "../../../cron/session-target.js";
import { rowToCronJob } from "../../../cron/store/row-codec.js";
import { decodeGatewayOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.codec.js";

export function isLegacyMainAutomation(raw: Record<string, unknown>): boolean {
  return (
    normalizeOptionalLowercaseString(raw.sessionTarget) === "main" ||
    (isRecord(raw.payload) && normalizeOptionalLowercaseString(raw.payload.kind) === "systemevent")
  );
}

export function migrateMainAutomation(raw: Record<string, unknown>, cfg: OpenClawConfig): string {
  const identity = String(raw.name) + " (" + String(raw.id) + ")";
  const payload = asNullableRecord(raw.payload);
  const systemEvent = payload?.kind === "systemEvent";
  const agentId = tryResolveCronJobEffectiveAgentId(
    {
      agentId: normalizeOptionalString(raw.agentId),
      sessionKey: normalizeOptionalString(raw.sessionKey),
    },
    tryResolveAmbientOwnerAgentId(cfg),
  );
  const sessionKey =
    agentId && listAgentIds(cfg).includes(agentId)
      ? resolveCanonicalMainSessionKey({
          agentId,
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
        })
      : undefined;
  const text = systemEvent ? payload.text : payload?.message;
  const prompt = typeof text === "string" && text.trim() ? text : undefined;
  const canContinue = systemEvent || payload?.kind === "agentTurn";
  const reason = !canContinue
    ? "This action cannot continue a conversation. Review how it should run and deliver results."
    : !prompt
      ? "There is no task text. Add a prompt before enabling this automation."
      : !sessionKey
        ? "The owning agent could not be resolved. Choose the conversation before enabling this automation."
        : undefined;
  if (systemEvent) {
    raw.payload = {
      kind: "agentTurn",
      message:
        prompt ?? "No reminder text was saved. Replace this prompt before enabling the automation.",
      ...(payload.toolsAllow !== undefined ? { toolsAllow: payload.toolsAllow } : {}),
      ...(payload.toolsAllowIsDefault !== undefined ? { toolsAllowIsDefault: false } : {}),
    };
  } else if (payload?.kind === "agentTurn" && !prompt) {
    payload.message = "No task text was saved. Replace this prompt before enabling the automation.";
  }
  raw.sessionTarget = canContinue && sessionKey ? "session:" + sessionKey : "isolated";
  if (agentId && sessionKey) {
    raw.agentId = agentId;
  }
  // Conversion must not opt an existing job into cron announcement defaults.
  raw.delivery ??= { mode: "none" };
  if (reason) {
    raw.enabled = false;
    raw.description = [raw.description, "Paused by Doctor: " + reason].filter(Boolean).join("\n\n");
    return "Paused " + identity + ": " + reason;
  }
  return "Converted " + identity + " to a task prompt in " + sessionKey + ".";
}

/** Rebind only an exact saved definition; a stale capture still needs an authenticated creator. */
export function rebindMainAutomationSource(
  raw: Record<string, unknown>,
  original: Record<string, unknown>,
): boolean {
  const source = asNullableRecord(original.operatorSource);
  if (!source) {
    return original.operatorSource === undefined;
  }
  const {
    operatorSource: _operatorSource,
    streamOperatorSource: _streamOperatorSource,
    description: _description,
    displayName: _displayName,
    createdActor: _createdActor,
    ownerProfileId: _ownerProfileId,
    ownerTransferPending: _ownerTransferPending,
    toolsAllowProvenance: _toolsAllowProvenance,
    runtimeAuthority: _runtimeAuthority,
    runtimeAuthorityRecoveryRequired: _runtimeAuthorityRecoveryRequired,
    updatedAtMs: _updatedAtMs,
    state: _state,
    ...definition
  } = original;
  // Old canonical rows already passed their storage codec. Never normalize an
  // unprovable old definition into one that happens to match its saved grant.
  if (source.executionRevision !== hashCronJobDefinition({ ...definition, enabled: true })) {
    return false;
  }
  const converted = rowToCronJob(
    { job_id: String(raw.id), state_json: "{}", runtime_updated_at_ms: 0, updated_at: 0 },
    raw,
  );
  if (!converted) {
    return false;
  }
  const captured = decodeGatewayOperatorRecoverySource(source.source);
  if (
    captured.agentId !== converted.agentId ||
    (captured.kind !== "gateway" && !isCronOperatorSourceParent(converted, captured.sessionKey))
  ) {
    return false;
  }
  raw.operatorSource = {
    ...source,
    executionRevision: resolveCronOperatorExecutionRevision(converted),
  };
  return true;
}
