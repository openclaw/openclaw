import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { SkillEntry } from "../types.js";

export function collectSkillBins(entries: SkillEntry[]): string[] {
  return normalizeSortedUniqueTrimmedStringList(
    entries.flatMap((entry) => [
      ...(entry.metadata?.requires?.bins ?? []),
      ...(entry.metadata?.requires?.anyBins ?? []),
      ...(entry.metadata?.install ?? []).flatMap((spec) => spec?.bins ?? []),
    ]),
  );
}
