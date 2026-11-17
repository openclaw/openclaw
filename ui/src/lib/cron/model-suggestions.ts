import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  asNullableObjectRecord,
  asNullableRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveCronJobEffectiveAgentId } from "../../../../src/cron/agent-id.ts";
import type { CronState } from "./types.ts";

/** Match the pending update: blank agent edits retain the saved override; Clear removes it. */
export function resolveCronModelAgentId(state: Pick<CronState, "cronForm" | "cronEditingJob">) {
  const form = state.cronForm;
  return tryResolveCronJobEffectiveAgentId({
    agentId: form.clearAgent ? undefined : form.agentId.trim() || state.cronEditingJob?.agentId,
    sessionKey: form.sessionKey,
  });
}

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null | undefined,
  agentId: string | undefined,
): string[] {
  const agents = asNullableObjectRecord(configForm?.agents);
  if (!agents) {
    return [];
  }
  const defaults = asNullableObjectRecord(agents.defaults);
  const entry = agentId
    ? asNullableObjectRecord(asNullableRecord(agents.entries)?.[agentId])
    : null;
  return normalizeSortedUniqueTrimmedStringList([
    ...listModelRefsFromConfigValue(defaults?.model),
    ...Object.keys(asNullableObjectRecord(defaults?.models) ?? {}),
    ...listModelRefsFromConfigValue(entry?.model),
  ]);
}
