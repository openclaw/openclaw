import { isLoopbackIpAddress } from "../shared/net/ip.js";
import type { GatewayProbeResult } from "./probe.js";

export function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

export function shouldTryLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
  hasSharedCredentials?: boolean;
  allowSharedCredentials?: boolean;
}): params is {
  gatewayMode: "local";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult;
  hasSharedCredentials?: boolean;
  allowSharedCredentials?: boolean;
} {
  if (
    params.gatewayMode !== "local" ||
    !params.gatewayProbe ||
    params.gatewayProbe.ok ||
    !isLoopbackGatewayUrl(params.gatewayUrl)
  ) {
    return false;
  }
  if (params.hasSharedCredentials === true && params.allowSharedCredentials !== true) {
    return false;
  }
  const capability = params.gatewayProbe.auth?.capability;
  if (capability === "pairing_pending") {
    return false;
  }
  const error = params.gatewayProbe.error?.toLowerCase() ?? "";
  return error.includes("timeout") || capability === "unknown";
}

export function shouldUseDeviceIdentityForLocalStatusRpcFallback(
  gatewayProbe: GatewayProbeResult,
): boolean {
  const capability = gatewayProbe.auth?.capability;
  return (
    capability === "read_only" || capability === "write_capable" || capability === "admin_capable"
  );
}

export async function applyLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
  hasSharedCredentials?: boolean;
  allowSharedCredentials?: boolean;
  callStatus: () => Promise<unknown>;
}): Promise<GatewayProbeResult | null> {
  if (!shouldTryLocalStatusRpcFallback(params)) {
    return params.gatewayProbe;
  }
  const status = await params.callStatus().catch(() => null);
  if (!status) {
    return params.gatewayProbe;
  }
  const auth = params.gatewayProbe.auth ?? {
    role: null,
    scopes: [],
    capability: "unknown" as const,
  };
  return {
    ...params.gatewayProbe,
    ok: true,
    status,
    auth:
      auth.capability === "unknown"
        ? {
            ...auth,
            capability: "read_only",
          }
        : auth,
  };
}
