import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type GatewayUrlOverrideSource = "cli" | "env";

export type GatewayTlsRuntimeLoader = (
  config: GatewayTlsConfig | undefined,
) => Promise<GatewayTlsRuntime>;

export async function resolveGatewayConnectionTlsFingerprint(params: {
  config: OpenClawConfig;
  url: string;
  urlOverrideSource?: GatewayUrlOverrideSource;
  explicitTlsFingerprint?: string;
  loadGatewayTlsRuntime: GatewayTlsRuntimeLoader;
}): Promise<string | undefined> {
  const remote =
    params.config.gateway?.mode === "remote" ? params.config.gateway.remote : undefined;
  const remoteUrl = normalizeOptionalString(remote?.url);
  const targetUsesTls = isWssUrl(params.url);
  const useLocalTls =
    params.config.gateway?.tls?.enabled === true &&
    !params.urlOverrideSource &&
    !remoteUrl &&
    targetUsesTls;
  const tlsRuntime = useLocalTls
    ? await params.loadGatewayTlsRuntime(params.config.gateway?.tls)
    : undefined;
  const explicitTlsFingerprint = normalizeOptionalString(params.explicitTlsFingerprint);
  const remoteTlsFingerprint =
    // Env URL overrides may still inherit configured remote TLS pinning for private cert
    // deployments. CLI overrides stay explicit-only so caller-supplied target URLs cannot
    // accidentally inherit an unrelated configured remote pin.
    params.config.gateway?.mode === "remote" &&
    params.urlOverrideSource !== "cli" &&
    (params.urlOverrideSource === "env" || Boolean(remoteUrl)) &&
    targetUsesTls
      ? normalizeOptionalString(remote?.tlsFingerprint)
      : undefined;
  return (
    explicitTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined)
  );
}

function isWssUrl(url: string): boolean {
  return url.toLowerCase().startsWith("wss://");
}
