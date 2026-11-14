import {
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
} from "../../../src/infra/format-time/format-duration-internal.ts";
import { t } from "../i18n/index.ts";
import { formatUnit } from "./format.ts";

export function formatDurationCompact(
  ms?: number | null,
  options?: { includeSeconds?: boolean },
): string | undefined {
  if (options?.includeSeconds && ms != null && Number.isFinite(ms) && ms >= 1_000) {
    const totalSeconds = Math.floor(ms / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    return [
      hours ? formatUnit({ value: hours, unit: "hour" }) : undefined,
      hours || minutes ? formatUnit({ value: minutes, unit: "minute" }) : undefined,
      formatUnit({ value: totalSeconds % 60, unit: "second" }),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return resolveCompactDurationParts(ms)?.map(formatUnit).join(" ");
}

export function formatDurationHuman(ms?: number | null, fallback = t("common.na")): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return resolveSingleUnitDurationParts(ms).map(formatUnit).join(" ");
}
