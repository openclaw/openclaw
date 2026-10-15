import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronJob, CronPayload } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { toNumber } from "../format.ts";
import type { CronFormState } from "./types.ts";

function isCronPayload(value: unknown): value is CronPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  if (value.kind === "agentTurn") {
    return typeof value.message === "string";
  }
  if (value.kind === "command") {
    return Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string");
  }
  if (value.kind === "script") {
    return typeof value.script === "string";
  }
  return false;
}

export function getCronJobPayload(job: CronJob): CronPayload | null {
  const payload: unknown = job.payload;
  return isCronPayload(payload) ? payload : null;
}

export function buildCronPayload(
  form: CronFormState,
  source: CronPayload | null,
  isUpdate: boolean,
) {
  // Clones carry public restrictions, not the source's capture markers or authority.
  // Updates must omit caps so the Gateway retains that job's existing authority.
  const toolsAllow = !isUpdate && source && "toolsAllow" in source ? source.toolsAllow : undefined;
  const restrictions = toolsAllow ? { toolsAllow: [...toolsAllow] } : {};
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error(t("cron.errors.systemEventTextRequired"));
    }
    return { kind: "systemEvent" as const, text, ...restrictions };
  }
  if (form.payloadKind !== "agentTurn") {
    throw new Error(`Cron ${form.payloadKind} payloads are read-only in Control UI.`);
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error(t("cron.errors.agentMessageRequiredShort"));
  }
  const original = source?.kind === "agentTurn" ? source : undefined;
  const cloned = isUpdate ? undefined : original;
  // Blank stored overrides clear on update; a new job leaves them inherited.
  const model =
    form.payloadModel.trim() || (isUpdate && original?.model !== undefined ? null : undefined);
  const thinking =
    form.payloadThinking.trim() ||
    (isUpdate && original?.thinking !== undefined ? null : undefined);
  const timeoutRaw = form.timeoutSeconds.trim();
  const timeoutSeconds = toNumber(timeoutRaw, Number.NaN);
  const lightContext =
    form.payloadLightContext || original?.lightContext !== undefined
      ? form.payloadLightContext
      : undefined;
  return {
    kind: "agentTurn" as const,
    message,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(timeoutRaw && Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0
      ? { timeoutSeconds }
      : isUpdate && original?.timeoutSeconds !== undefined
        ? { timeoutSeconds: null }
        : {}),
    ...(lightContext !== undefined ? { lightContext } : {}),
    ...(form.payloadSkipIfScratchEmpty || original?.skipIfScratchEmpty !== undefined
      ? { skipIfScratchEmpty: form.payloadSkipIfScratchEmpty }
      : {}),
    ...restrictions,
    ...(cloned?.fallbacks ? { fallbacks: [...cloned.fallbacks] } : {}),
    ...(cloned?.allowUnsafeExternalContent !== undefined
      ? { allowUnsafeExternalContent: cloned.allowUnsafeExternalContent }
      : {}),
    ...(form.payloadIncludeReasoning || original?.includeReasoning !== undefined
      ? { includeReasoning: form.payloadIncludeReasoning }
      : {}),
  };
}
