import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { SkillEntry } from "../types.js";

/** Every bin a skill entry may run: required bins, any-of bins, and installer-provided bins. */
export function collectSkillBins(entries: SkillEntry[]): string[] {
  return normalizeSortedUniqueTrimmedStringList(
    entries.flatMap((entry) => [
      ...(entry.metadata?.requires?.bins ?? []),
      ...(entry.metadata?.requires?.anyBins ?? []),
      ...(entry.metadata?.install ?? []).flatMap((spec) => spec?.bins ?? []),
    ]),
  );
}
