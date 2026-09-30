import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { SkillEntry } from "../types.js";

/** Collects all binary names a set of skills may require or install. */
export function collectSkillBins(entries: SkillEntry[]): string[] {
  return normalizeSortedUniqueTrimmedStringList(
    entries.flatMap((entry) => [
      ...(entry.metadata?.requires?.bins ?? []),
      ...(entry.metadata?.requires?.anyBins ?? []),
      ...(entry.metadata?.install ?? []).flatMap((spec) => spec?.bins ?? []),
    ]),
  );
}
