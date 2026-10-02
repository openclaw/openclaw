import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { readSystemInfo } from "../../lib/system-info.ts";

export async function discoverGatewayName(
  gateway: ApplicationGateway | null,
  available: boolean,
  signal: AbortSignal,
): Promise<string> {
  if (!gateway || !available) {
    return "";
  }
  try {
    const { value: result } = await readSystemInfo(gateway, signal, { fresh: true });
    return (
      normalizeOptionalString(result.machineName) ??
      normalizeOptionalString(result.hostname)?.split(".", 1)[0] ??
      ""
    );
  } catch {
    return "";
  }
}
