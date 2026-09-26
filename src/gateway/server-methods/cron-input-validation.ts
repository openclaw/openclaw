import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertValidCronAnnounceDelivery,
  assertValidCronFailureAlert,
} from "../../cron/delivery-channel-validation.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { resolveFailureAlert } from "../../cron/service/failure-alerts.js";
import { applyJobPatch } from "../../cron/service/jobs.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob, CronJobPatch } from "../../cron/types.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";

/** Validate authored fields before normalization can erase blank or invalid input. */
export function normalizeCronAddRequest(params: unknown): {
  candidate: unknown;
  enabledExplicit: boolean;
} {
  const rawParams = asOptionalObjectRecord(params);
  for (const key of ["declarationKey", "displayName"]) {
    const value = rawParams?.[key];
    if (typeof value === "string" && value.trim().length === 0) {
      throw new Error(`${key} must not be blank`);
    }
  }
  const hasEnabled = Boolean(rawParams && Object.hasOwn(rawParams, "enabled"));
  const parsedEnabled = hasEnabled ? parseBoolean(rawParams?.enabled) : undefined;
  if (hasEnabled && parsedEnabled === undefined) {
    throw new Error("enabled must be a boolean");
  }
  assertCronDeliveryInputNonBlankFields(rawParams?.delivery);
  return {
    candidate:
      normalizeCronJobCreate(params, {
        sessionContext: { sessionKey: readStringField(rawParams, "sessionKey") },
      }) ?? params,
    enabledExplicit: parsedEnabled !== undefined,
  };
}

export function normalizeCronUpdateRequest(params: unknown): {
  candidate: unknown;
  normalizedPatch: CronJobPatch | null;
} {
  const rawParams = asOptionalObjectRecord(params);
  const rawPatch = rawParams?.patch;
  const patchFields = asOptionalObjectRecord(rawPatch);
  const rawDisplayName = patchFields?.displayName;
  if (typeof rawDisplayName === "string" && rawDisplayName.trim().length === 0) {
    throw new Error("displayName must not be blank");
  }
  assertCronDeliveryInputNonBlankFields(patchFields?.delivery);
  const normalizedPatch = normalizeCronJobPatch(rawPatch);
  return {
    candidate: normalizedPatch && rawParams ? { ...rawParams, patch: normalizedPatch } : params,
    normalizedPatch,
  };
}

export async function assertValidCronUpdatePatch(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  currentJob: CronJob;
  patch: CronJobPatch;
}) {
  // Apply the full patch so service-owned payload/session constraints are
  // checked before mutation; configured-channel checks stay delivery-scoped so
  // stale existing delivery does not block unrelated updates like disabling.
  const nextJob = structuredClone(params.currentJob);
  applyJobPatch(nextJob, params.patch, {
    defaultAgentId: params.defaultAgentId,
    cronConfig: params.cfg.cron,
  });
  if (
    "agentId" in params.patch ||
    "sessionTarget" in params.patch ||
    "sessionKey" in params.patch
  ) {
    assertCronDoesNotTargetAgentHarness(nextJob);
  }
  // Clearing a concrete channel (channel: null) while keeping a bare announce `to`
  // intentionally falls back to "last" in multi-channel configs. Use the same
  // adjusted delivery for both the delivery check and the inherited-alert check so
  // an alert that inherits the route is judged identically to the delivery itself.
  const effectiveDelivery =
    params.patch.delivery?.channel === null &&
    nextJob.delivery &&
    (nextJob.delivery.mode ?? "announce") === "announce" &&
    nextJob.delivery.channel === undefined &&
    resolveTargetPrefixedChannel(nextJob.delivery.to) === undefined
      ? { ...nextJob.delivery, channel: "last" as const }
      : nextJob.delivery;
  if ("delivery" in params.patch) {
    await assertValidCronAnnounceDelivery({
      cfg: params.cfg,
      delivery: effectiveDelivery,
    });
  }
  // Compare the canonical before/after policy so route-changing edits are
  // validated without blocking threshold-only edits on legacy stored channels.
  const failureAlertPatch = params.patch.failureAlert;
  const failureAlertRoutingPatched =
    failureAlertPatch &&
    ("channel" in failureAlertPatch || "to" in failureAlertPatch || "mode" in failureAlertPatch);
  const currentAlert = resolveFailureAlert(
    { deps: { cronConfig: params.cfg.cron } },
    params.currentJob,
  );
  const nextAlert = resolveFailureAlert(
    { deps: { cronConfig: params.cfg.cron } },
    { ...nextJob, delivery: effectiveDelivery },
  );
  const alertNewlyEnabled = currentAlert === null && nextAlert !== null;
  const alertRouteChanged =
    currentAlert?.mode !== nextAlert?.mode ||
    currentAlert?.channel !== nextAlert?.channel ||
    currentAlert?.to !== nextAlert?.to ||
    currentAlert?.accountId !== nextAlert?.accountId ||
    currentAlert?.threadId !== nextAlert?.threadId;
  if (
    failureAlertRoutingPatched ||
    alertNewlyEnabled ||
    (alertRouteChanged && (params.patch.delivery !== undefined || failureAlertPatch === null))
  ) {
    await assertValidCronFailureAlert({
      cfg: params.cfg,
      failureAlert: nextJob.failureAlert,
      delivery: effectiveDelivery,
    });
  }
  return nextJob;
}

export function assertCronDoesNotTargetAgentHarness(input: {
  agentId?: string | null;
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): void {
  const targetSessionKey =
    resolveCronSessionTargetSessionKey(input.sessionTarget) ??
    (input.sessionTarget === "current" ? input.sessionKey?.trim() : undefined);
  if (!targetSessionKey) {
    return;
  }

  const loaded = loadGatewaySessionEntryReadOnly(
    targetSessionKey,
    input.agentId?.trim() ? { agentId: input.agentId.trim() } : {},
  );
  const reservedKey =
    isAgentHarnessSessionKey(targetSessionKey) || isAgentHarnessSessionKey(loaded.canonicalKey);
  if (loaded.entry?.modelSelectionLocked === true) {
    // Detached cron execution is a generic model path and cannot preserve a
    // harness-owned runtime lock, even when the durable row uses an ordinary key.
    throw new Error(
      reservedKey
        ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
        : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  }
  if (!reservedKey || loaded.entry) {
    // `harness:*` was historically a valid public key. Preserve an existing
    // unlocked row while reserving missing keys for trusted harness creation.
    return;
  }

  // Cron's detached runner does not carry the owning harness lock. Harness
  // execution targets must enter through ordinary session dispatch instead.
  throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
}
