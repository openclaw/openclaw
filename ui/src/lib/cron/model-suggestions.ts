import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  asNullableObjectRecord,
  asNullableRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null | undefined,
): string[] {
  const agents = asNullableObjectRecord(configForm?.agents);
  if (!agents) {
    return [];
  }
  const defaults = asNullableObjectRecord(agents.defaults);
  return normalizeSortedUniqueTrimmedStringList([
    ...listModelRefsFromConfigValue(defaults?.model),
    ...Object.keys(asNullableObjectRecord(defaults?.models) ?? {}),
    ...Object.values(asNullableRecord(agents.entries) ?? {}).flatMap((entry) =>
      listModelRefsFromConfigValue(asNullableObjectRecord(entry)?.model),
    ),
  ]);
}
