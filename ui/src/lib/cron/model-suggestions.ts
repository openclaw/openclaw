import {
  asNullableObjectRecord,
  asNullableRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";

function addModelId(target: Set<string>, value: unknown) {
  const trimmed = normalizeOptionalString(value);
  if (trimmed) {
    target.add(trimmed);
  }
}

function addModelConfigIds(target: Set<string>, modelConfig: unknown) {
  if (typeof modelConfig === "string") {
    addModelId(target, modelConfig);
    return;
  }
  const record = asNullableObjectRecord(modelConfig);
  if (!record) {
    return;
  }
  addModelId(target, record.primary);
  addModelId(target, record.model);
  addModelId(target, record.id);
  addModelId(target, record.value);
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
    : Array.isArray(record.fallback)
      ? record.fallback
      : [];
  for (const fallback of fallbacks) {
    addModelId(target, fallback);
  }
}

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null | undefined,
): string[] {
  const agents = asNullableObjectRecord(configForm?.agents);
  if (!agents) {
    return [];
  }
  const out = new Set<string>();
  const defaults = asNullableObjectRecord(agents.defaults);
  if (defaults) {
    addModelConfigIds(out, defaults.model);
    for (const modelId of Object.keys(asNullableObjectRecord(defaults.models) ?? {})) {
      addModelId(out, modelId);
    }
  }
  for (const entry of Object.values(asNullableRecord(agents.entries) ?? {})) {
    addModelConfigIds(out, asNullableObjectRecord(entry)?.model);
  }
  return sortUniqueStrings([...out]);
}
