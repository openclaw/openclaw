import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hashCronJobDefinition } from "../definition-hash.js";
import { stripCronPinnedExecGrant } from "../scheduled-tool-policy.js";
import { parseCronStreamSandboxTarget } from "../stream-sandbox-target.js";
import type { CronStoredJob, CronStoreFile } from "../types.js";
import {
  decodeCronJobConfig as decodeDeliveryConfig,
  deliveryToJson,
  hasCanonicalCronDeliveryMode,
} from "./delivery-codec.js";

export function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const {
    streamSandbox: rawStreamSandbox,
    runtimeAuthority: _runtimeAuthority,
    runtimeAuthorityRecoveryRequired: _runtimeAuthorityRecoveryRequired,
    state: _state,
    updatedAtMs: _updatedAtMs,
    ...rest
  } = job;
  const streamSandbox = parseCronStreamSandboxTarget(rawStreamSandbox);
  if (rawStreamSandbox !== undefined && (!streamSandbox || job.schedule.kind !== "stream")) {
    throw new Error(`Cannot persist invalid sandbox stream target for cron job ${job.id}`);
  }
  const payload = isRecord(rest.payload) ? rest.payload : undefined;
  const toolsAllow = Array.isArray(payload?.toolsAllow)
    ? payload.toolsAllow.filter((tool): tool is string => typeof tool === "string")
    : undefined;
  const storedToolsAllow = stripCronPinnedExecGrant({
    toolsAllow,
    requirement: rest.toolsAllowExecTargetRequirement,
  });
  // Runtime state and authority have separate owners; JSON is canonical for config.
  return {
    ...rest,
    ...(streamSandbox
      ? { streamSandbox, schedule: { ...job.schedule, kind: "sandbox-stream" } }
      : {}),
    ...(payload && storedToolsAllow
      ? { payload: { ...payload, toolsAllow: storedToolsAllow } }
      : {}),
    ...(rest.delivery && hasCanonicalCronDeliveryMode(rest.delivery)
      ? { delivery: deliveryToJson(rest.delivery) }
      : {}),
    state: {},
  };
}

export function resolveCronJobGrantDefinitionRevision(job: CronStoredJob): string {
  // Match job_json: drop ordinary undefined fields after deliveryToJson has
  // encoded meaningful explicit destination clears as null.
  const storedDefinition = safeParseJsonRecord(JSON.stringify(stripJobRuntimeFields(job)));
  if (!storedDefinition) {
    throw new Error(`Cannot canonicalize cron job ${job.id} for grant revision`);
  }
  const { enabled: _enabled, state: _state, ...definition } = storedDefinition;
  return hashCronJobDefinition(definition);
}

/** Restore supported runtime config without changing the marker retained for recovery. */
export function decodeStoredCronJobConfig(
  jobJson: Record<string, unknown>,
): Record<string, unknown> {
  const schedule = isRecord(jobJson.schedule) ? jobJson.schedule : undefined;
  const streamSandbox = parseCronStreamSandboxTarget(jobJson.streamSandbox);
  return {
    ...decodeDeliveryConfig(jobJson),
    ...(schedule?.kind === "sandbox-stream" && streamSandbox
      ? { schedule: { ...schedule, kind: "stream" }, streamSandbox }
      : {}),
  };
}
