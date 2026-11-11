import * as format from "../format.ts";
import { getLocale } from "./i18n.ts";

// Existing formatters own formatting; Solid consumers also observe locale changes.
export function formatDateTimeMs(...args: Parameters<typeof format.formatDateTimeMs>) {
  getLocale();
  return format.formatDateTimeMs(...args);
}

export function formatRelativeTimestamp(
  ...args: Parameters<typeof format.formatRelativeTimestamp>
) {
  getLocale();
  return format.formatRelativeTimestamp(...args);
}

export function formatTimeMs(...args: Parameters<typeof format.formatTimeMs>) {
  getLocale();
  return format.formatTimeMs(...args);
}

export function formatNumber(...args: Parameters<typeof format.formatNumber>) {
  getLocale();
  return format.formatNumber(...args);
}

export function formatCost(...args: Parameters<typeof format.formatCost>) {
  getLocale();
  return format.formatCost(...args);
}

export function formatUsd(...args: Parameters<typeof format.formatUsd>) {
  getLocale();
  return format.formatUsd(...args);
}

export function formatDateTimeRangeMs(...args: Parameters<typeof format.formatDateTimeRangeMs>) {
  getLocale();
  return format.formatDateTimeRangeMs(...args);
}

export function formatMs(...args: Parameters<typeof format.formatMs>) {
  getLocale();
  return format.formatMs(...args);
}

export function createMsFormatter(...args: Parameters<typeof format.createMsFormatter>) {
  const renderTimestamp = format.createMsFormatter(...args);
  return (ms?: number | null) => {
    getLocale();
    return renderTimestamp(ms);
  };
}
