import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export function normalizeActivationRouteId(value: string | undefined): string {
  const normalized = normalizeOptionalLowercaseString(value) ?? "";
  switch (normalized) {
    case "webhook":
    case "gateway-webhook":
      return "gateway-plugin-http";
    default:
      return normalized;
  }
}
