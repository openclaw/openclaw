import { ensureExplicitGatewayAuth, resolveExplicitGatewayAuth } from "../../gateway/call.js";
import { probeGateway } from "../../gateway/probe.js";
import { withProgress } from "../progress.js";

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  timeoutMs: number;
  json?: boolean;
  configPath?: string;
  requireExplicitAuth?: boolean;
  allowLoopbackDeviceIdentity?: boolean;
}) {
  try {
    if (opts.requireExplicitAuth) {
      ensureExplicitGatewayAuth({
        urlOverride: opts.url,
        urlOverrideSource: "cli",
        explicitAuth: resolveExplicitGatewayAuth({
          token: opts.token,
          password: opts.password,
        }),
        resolvedAuth: {
          token: opts.token,
          password: opts.password,
        },
        errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
        configPath: opts.configPath,
      });
    }
    await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        const result = await probeGateway({
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          timeoutMs: opts.timeoutMs,
          detailLevel: "health",
          allowLoopbackDeviceIdentity: opts.allowLoopbackDeviceIdentity,
        });
        if (!result.ok) {
          throw new Error(result.error ?? "gateway probe failed");
        }
      },
    );
    return { ok: true } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
}
