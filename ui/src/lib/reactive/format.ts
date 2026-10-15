import * as format from "../format.ts";
import { getLocale } from "./i18n.ts";

// Existing formatters own formatting; Solid consumers also observe locale changes.
export function formatDateMs(...args: Parameters<typeof format.formatDateMs>) {
  getLocale();
  return format.formatDateMs(...args);
}

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
