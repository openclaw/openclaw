import type { OpenClawConfig } from "../../../config/config.js";
import { isValidEnvSecretRefId } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import { normalizeGatewayTokenInput, randomToken } from "../../onboard-helpers.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function applyNonInteractiveGatewayConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  defaultPort: number;
}): {
  nextConfig: OpenClawConfig;
  port: number;
  bind: string;
  authMode: string;
  tailscaleMode: string;
  tailscaleResetOnExit: boolean;
  gatewayToken?: string;
} | null {
  const { opts, runtime } = params;

  const hasGatewayPort = opts.gatewayPort !== undefined;
  if (hasGatewayPort && (!Number.isFinite(opts.gatewayPort) || (opts.gatewayPort ?? 0) <= 0)) {
    runtime.error("Invalid --gateway-port");
    runtime.exit(1);
    return null;
  }

  const port = hasGatewayPort ? (opts.gatewayPort as number) : params.defaultPort;
  let bind = opts.gatewayBind ?? "loopback";
  const authModeRaw = opts.gatewayAuth ?? "token";
  if (authModeRaw !== "token" && authModeRaw !== "password" && authModeRaw !== "trusted-proxy") {
    runtime.error("Invalid --gateway-auth (use token|password|trusted-proxy).");
    runtime.exit(1);
    return null;
  }
  let authMode = authModeRaw;
  const tailscaleMode = opts.tailscale ?? "off";
  const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);

  // Tighten config to safe combos:
  // - If Tailscale is on, force loopback bind (the tunnel handles external access).
  // - If using Tailscale Funnel, require password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }
  if (tailscaleMode === "funnel" && authMode !== "password") {
    authMode = "password";
  }

  let nextConfig = params.nextConfig;
  const explicitGatewayToken = normalizeGatewayTokenInput(opts.gatewayToken);
  const envGatewayToken = normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
  let gatewayToken = explicitGatewayToken || envGatewayToken || undefined;
  const gatewayTokenRefEnv = String(opts.gatewayTokenRefEnv ?? "").trim();

  if (authMode === "token") {
    if (gatewayTokenRefEnv) {
      if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
        runtime.error(
          "Invalid --gateway-token-ref-env (use env var name like OPENCLAW_GATEWAY_TOKEN).",
        );
        runtime.exit(1);
        return null;
      }
      if (explicitGatewayToken) {
        runtime.error("Use either --gateway-token or --gateway-token-ref-env, not both.");
        runtime.exit(1);
        return null;
      }
      const resolvedFromEnv = process.env[gatewayTokenRefEnv]?.trim();
      if (!resolvedFromEnv) {
        runtime.error(`Environment variable "${gatewayTokenRefEnv}" is missing or empty.`);
        runtime.exit(1);
        return null;
      }
      gatewayToken = resolvedFromEnv;
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          auth: {
            ...nextConfig.gateway?.auth,
            mode: "token",
            token: {
              source: "env",
              provider: resolveDefaultSecretProviderAlias(nextConfig, "env", {
                preferFirstProviderForSource: true,
              }),
              id: gatewayTokenRefEnv,
            },
          },
        },
      };
    } else {
      if (!gatewayToken) {
        gatewayToken = randomToken();
      }
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          auth: {
            ...nextConfig.gateway?.auth,
            mode: "token",
            token: gatewayToken,
          },
        },
      };
    }
  }

  if (authMode === "password") {
    const password = opts.gatewayPassword?.trim();
    if (!password) {
      runtime.error("Missing --gateway-password for password auth.");
      runtime.exit(1);
      return null;
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  }

  if (authMode === "trusted-proxy") {
    // Parse trusted proxy inputs from opts. Accept comma-separated or array.
    const rawTrusted = opts.gatewayTrustedProxies ?? [];
    const trustedProxiesArr: string[] = [];
    if (Array.isArray(rawTrusted)) {
      for (const v of rawTrusted) {
        if (typeof v === "string") {
          trustedProxiesArr.push(
            ...v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    } else if (typeof rawTrusted === "string") {
      trustedProxiesArr.push(
        ...rawTrusted
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    if (trustedProxiesArr.length === 0) {
      runtime.error(
        "Missing --gateway-trusted-proxies for trusted-proxy auth (provide one or more IPs).",
      );
      runtime.exit(1);
      return null;
    }

    const userHeaderRaw = opts.gatewayTrustedProxyUserHeader ?? "x-forwarded-user";
    const userHeader = String(userHeaderRaw).trim();
    if (!userHeader) {
      runtime.error("Invalid --gateway-trusted-proxy-user-header (must be a header name).");
      runtime.exit(1);
      return null;
    }

    const rawRequired = opts.gatewayTrustedProxyRequiredHeaders ?? [];
    const requiredHeaders: string[] = [];
    if (Array.isArray(rawRequired)) {
      for (const v of rawRequired) {
        if (typeof v === "string") {
          requiredHeaders.push(
            ...v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    } else if (typeof rawRequired === "string") {
      requiredHeaders.push(
        ...rawRequired
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }

    const rawAllowUsers = opts.gatewayTrustedProxyAllowUsers ?? [];
    const allowUsers: string[] = [];
    if (Array.isArray(rawAllowUsers)) {
      for (const v of rawAllowUsers) {
        if (typeof v === "string") {
          allowUsers.push(
            ...v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    } else if (typeof rawAllowUsers === "string") {
      allowUsers.push(
        ...rawAllowUsers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }

    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader,
            ...(requiredHeaders.length > 0 ? { requiredHeaders } : {}),
            ...(allowUsers.length > 0 ? { allowUsers } : {}),
          },
        },
        trustedProxies: trustedProxiesArr,
      },
    };
    // Apply Control UI allowed origins if provided
    const rawAllowedOrigins =
      opts.gatewayControlUiAllowedOrigins ?? opts.gatewayControlUiAllowedOrigins;
    const allowedOriginsArr: string[] = [];
    if (Array.isArray(rawAllowedOrigins)) {
      for (const v of rawAllowedOrigins) {
        if (typeof v === "string") {
          allowedOriginsArr.push(
            ...v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    } else if (typeof rawAllowedOrigins === "string") {
      allowedOriginsArr.push(
        ...rawAllowedOrigins
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    if (allowedOriginsArr.length > 0) {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          controlUi: {
            ...nextConfig.gateway?.controlUi,
            allowedOrigins: allowedOriginsArr,
          },
        },
      };
    }
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind,
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return {
    nextConfig,
    port,
    bind,
    authMode,
    tailscaleMode,
    tailscaleResetOnExit,
    gatewayToken,
  };
}
