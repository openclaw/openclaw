import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
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
  for (const ref of listModelRefsFromConfigValue(modelConfig)) {
    addModelId(target, ref);
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
