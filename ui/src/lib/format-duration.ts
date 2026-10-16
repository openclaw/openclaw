import {
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
} from "../../../src/infra/format-time/format-duration-internal.ts";
import { i18n, t } from "../i18n/index.ts";
import { formatUnit } from "./format.ts";

export function formatDurationCompact(ms?: number | null): string | undefined {
  return resolveCompactDurationParts(ms)?.map(formatUnit).join(" ");
}

let longDurationList: { locale: string; formatter: Intl.ListFormat } | undefined;

export function formatDurationLong(ms?: number | null): string | undefined {
  const parts = resolveCompactDurationParts(ms);
  if (!parts) {
    return undefined;
  }
  const locale = i18n.getLocale();
  if (longDurationList?.locale !== locale) {
    longDurationList = {
      locale,
      formatter: new Intl.ListFormat(locale, { type: "unit", style: "long" }),
    };
  }
  return longDurationList.formatter.format(
    parts.map((part) => formatUnit({ ...part, unitDisplay: "long" })),
  );
}

export function formatDurationHuman(ms?: number | null, fallback = t("common.na")): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return resolveSingleUnitDurationParts(ms).map(formatUnit).join(" ");
}
