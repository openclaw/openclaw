import {
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
} from "../../gateway/explicit-auth.js";
import { isSecureWebSocketUrl } from "../../gateway/net.js";
import { probeGateway } from "../../gateway/probe.js";
import { withProgress } from "../progress.js";

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  explicitToken?: string;
  explicitPassword?: string;
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
          token: opts.explicitToken,
          password: opts.explicitPassword,
        }),
        resolvedAuth: {
          token: opts.token,
          password: opts.password,
        },
        errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
        configPath: opts.configPath,
      });
    }
    const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
    if (!isSecureWebSocketUrl(opts.url, { allowPrivateWs })) {
      throw new Error(
        [
          `SECURITY ERROR: Gateway URL "${opts.url}" uses plaintext ws:// to a non-loopback address.`,
          "Both credentials and chat data would be exposed to network interception.",
          "Source: cli --url",
          opts.configPath ? `Config: ${opts.configPath}` : undefined,
          "Fix: Use wss:// for remote gateway URLs.",
          "Safe remote access defaults:",
          "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
          "- or use Tailscale Serve/Funnel for HTTPS remote access",
          allowPrivateWs
            ? undefined
            : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
          "Doctor: openclaw doctor --fix",
          "Docs: https://docs.openclaw.ai/gateway/remote",
        ]
          .filter(Boolean)
          .join("\n"),
      );
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
