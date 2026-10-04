import { asOptionalObjectRecord } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";

const SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1000;

export function isGatewayHealthzResponse(statusCode: number | undefined, body: string): boolean {
  if (statusCode !== 200) {
    return false;
  }
  try {
    const payload = asOptionalObjectRecord(JSON.parse(body));
    return payload?.ok === true && payload.status === "live";
  } catch {
    return false;
  }
}

export function createConfiguredGatewayHealthProbe(cfg: OpenClawConfig) {
  const probe = createConfiguredGatewayLocalProbe(cfg);
  return async (params: { host: string; port: number }): Promise<boolean> => {
    const result = await probe.requestHttp({
      ...params,
      pathname: "/healthz",
      timeoutMs: SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS,
    });
    return isGatewayHealthzResponse(result?.statusCode, result?.body ?? "");
  };
}
