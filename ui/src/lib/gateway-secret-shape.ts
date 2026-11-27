import { base64ToBytes } from "./bytes-base64.ts";

/** Advisory only: device tokens have no prefix distinct from an arbitrary Gateway secret. */
export function classifyGatewaySecret(value: string): "setup-code" | "unknown" {
  const trimmed = value.trim();
  const code = trimmed.toLowerCase().startsWith("oc-pair://") ? trimmed.slice(10) : trimmed;
  if (!/^[A-Za-z0-9_-]+$/u.test(code)) {
    return "unknown";
  }
  try {
    const bytes = base64ToBytes(code.replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return payload !== null &&
      typeof payload === "object" &&
      "url" in payload &&
      typeof payload.url === "string" &&
      payload.url.trim() !== "" &&
      "bootstrapToken" in payload &&
      typeof payload.bootstrapToken === "string" &&
      payload.bootstrapToken.trim() !== ""
      ? "setup-code"
      : "unknown";
  } catch {
    return "unknown";
  }
}
