import { normalizeOptionalString } from "../shared/string-coerce.js";

export const testServiceAuditCodes = {
  gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
  gatewayTokenMismatch: "gateway-token-mismatch",
} as const;

export function readEmbeddedGatewayTokenForTest(
  command: {
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, "inline" | "file">;
  } | null,
) {
  return command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN === "file"
    ? undefined
    : normalizeOptionalString(command?.environment?.OPENCLAW_GATEWAY_TOKEN);
}
