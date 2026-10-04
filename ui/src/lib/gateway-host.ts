// Host label for a Gateway URL, shared by startup-path dialogs and lazy pages.
// Keep this module dependency-free: the switch confirmation renders at startup.
import { t } from "../i18n/index.ts";

export function formatGatewayHost(gatewayUrl: string | undefined): string {
  const raw = gatewayUrl?.trim() ?? "";
  if (!raw) {
    return t("common.unknown");
  }
  return URL.parse(raw)?.host || raw;
}
