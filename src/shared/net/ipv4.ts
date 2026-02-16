import { t } from "../../i18n/index.js";

export function validateIPv4AddressInput(value: string | undefined): string | undefined {
  if (!value) {
    return t("config.validation.ipv4_required");
  }
  const trimmed = value.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 4) {
    return t("config.validation.ipv4_invalid_format");
  }
  if (
    parts.every((part) => {
      const n = parseInt(part, 10);
      return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
    })
  ) {
    return undefined;
  }
  return t("config.validation.ipv4_octet_range");
}
