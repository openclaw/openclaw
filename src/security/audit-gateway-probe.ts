// Gateway probing and credential-safe projection for deep security audits.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } from "../gateway/probe-auth.js";
import { probeGateway } from "../gateway/probe.js";
import type { SecurityAuditReport } from "./audit.types.js";

export async function probeSecurityAuditGateway(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  probe?: typeof probeGateway;
  explicitAuth?: { token?: string; password?: string };
}): Promise<{
  deep: SecurityAuditReport["deep"];
  authWarning?: string;
}> {
  const connection = buildGatewayConnectionDetails({ config: params.cfg });
  const url = connection.url;
  const probeTarget = resolveGatewayProbeTarget(params.cfg);

  const authResolution = resolveGatewayProbeAuthSafe({
    cfg: params.cfg,
    env: params.env,
    mode: probeTarget.mode,
    explicitAuth: params.explicitAuth,
  });
  const res = await (params.probe ?? probeGateway)({
    url,
    config: params.cfg,
    env: params.env,
    originScopedDeviceAuth:
      probeTarget.mode === "remote" || Boolean(process.env.OPENCLAW_GATEWAY_URL?.trim()),
    auth: authResolution.auth,
    timeoutMs: params.timeoutMs,
  }).catch((err: unknown) => ({
    ok: false,
    url,
    connectLatencyMs: null,
    error: String(err),
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  }));

  if (authResolution.warning && !res.ok) {
    res.error = res.error ? `${res.error}; ${authResolution.warning}` : authResolution.warning;
  }

  return {
    deep: {
      gateway: {
        attempted: true,
        url: redactSensitiveUrlLikeString(url),
        ok: res.ok,
        error: res.ok || res.error === null ? null : redactSensitiveUrlLikeString(res.error),
        close: res.close
          ? {
              code: res.close.code,
              reason: redactSensitiveUrlLikeString(res.close.reason),
            }
          : null,
      },
    },
    authWarning: authResolution.warning,
  };
}
