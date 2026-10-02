import {
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
} from "../../../src/infra/format-time/format-duration-internal.ts";
import { t } from "../i18n/index.ts";
import { formatUnit } from "./format.ts";

export function formatDurationCompact(ms?: number | null): string | undefined {
  return resolveCompactDurationParts(ms)?.map(formatUnit).join(" ");
}

export function formatDurationHuman(ms?: number | null, fallback = t("common.na")): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return resolveSingleUnitDurationParts(ms).map(formatUnit).join(" ");
}
