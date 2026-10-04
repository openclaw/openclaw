// Configure wizard Gateway port, bind, auth, and Tailscale prompts.
import { parseIpAddressOrCidr } from "@openclaw/net-policy/ip";
import { validateDottedDecimalIPv4Input } from "@openclaw/net-policy/ipv4";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveGatewayPort } from "../config/config.js";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidEnvSecretRefId, type SecretInput } from "../config/types.secrets.js";
import {
  maybeAddTailnetOriginToControlUiAllowedOrigins,
  validateGatewayPortInput,
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
} from "../gateway/gateway-config-prompts.shared.js";
import { isLoopbackAddress, isTrustedProxyAddress } from "../gateway/net.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import type { RuntimeEnv } from "../runtime.js";
import { createGatewayEnvSecretRef } from "../secrets/ref-contract.js";
import { t } from "../wizard/i18n/index.js";
import { createConfigurePrompts } from "./configure.prompts.js";
import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";
type GatewayTokenInputMode = "plaintext" | "ref";

/** Prompt for local Gateway network/auth settings and return config plus call token. */
export async function promptGatewayConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: OpenClawConfig;
  port: number;
  token?: string;
}> {
  const prompts = createConfigurePrompts(runtime);
  const portRaw = await prompts.text({
    message: "Gateway port",
    initialValue: String(resolveGatewayPort(cfg)),
    validate: validateGatewayPortInput,
  });
  const port = parseTcpPort(portRaw) ?? resolveGatewayPort(cfg);

  let bind = await prompts.select({
    message: "Gateway bind mode",
    options: [
      {
        value: "loopback",
        label: "Loopback (Local only)",
        hint: "Bind to 127.0.0.1 - secure, local-only access",
      },
      {
        value: "tailnet",
        label: "Tailnet (Tailscale IP)",
        hint: "Bind to your Tailscale IP plus local loopback",
      },
      {
        value: "auto",
        label: "Auto (Loopback → LAN)",
        hint: "Prefer loopback; fall back to all interfaces if unavailable",
      },
      {
        value: "lan",
        label: "LAN (All interfaces)",
        hint: "Bind to 0.0.0.0 - accessible from anywhere on your network",
      },
      {
        value: "custom",
        label: "Custom IP",
        hint: "Specific IPv4s also bind 127.0.0.1",
      },
    ],
  });

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = await prompts.text({
      message: "Custom IP address",
      placeholder: "192.168.1.100",
      validate: validateDottedDecimalIPv4Input,
    });
    customBindHost = readStringValue(input);
  }

  let authMode = await prompts.select<GatewayAuthChoice>({
    message: "Gateway access protection",
    options: [
      { value: "token", label: "Token (recommended)", hint: "Recommended default" },
      { value: "password", label: "Password" },
      {
        value: "trusted-proxy",
        label: "Trusted Proxy",
        hint: "Behind reverse proxy (Pomerium, Caddy, Traefik, etc.)",
      },
    ],
    initialValue: "token",
  });

  let tailscaleMode = await prompts.select({
    message: "Tailscale exposure",
    options: [...TAILSCALE_EXPOSURE_OPTIONS],
  });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  // Persist the path so getTailnetHostname can reuse it for origin injection.
  let tailscaleBin: string | null = null;
  if (tailscaleMode !== "off") {
    tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
    }
  }

  if (tailscaleMode !== "off") {
    note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
  }

  // Disable incompatible exposure before it rewrites the selected auth or bind.
  // Same-host proxies still require explicit loopback trust and consent.
  if (authMode === "trusted-proxy" && tailscaleMode !== "off") {
    note(
      "Trusted proxy auth is incompatible with Tailscale serve/funnel. Disabling Tailscale.",
      "Note",
    );
    tailscaleMode = "off";
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
    bind = "loopback";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: SecretInput | undefined;
  let gatewayTokenForCalls: string | undefined;
  let gatewayPassword: string | undefined;
  let trustedProxyConfig: GatewayTrustedProxyConfig | undefined;
  let trustedProxies: string[] | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInputMode = await prompts.select<GatewayTokenInputMode>({
      message: "Gateway token source",
      options: [
        {
          value: "plaintext",
          label: "Generate/store plaintext token",
          hint: "Default",
        },
        {
          value: "ref",
          label: "Use SecretRef",
          hint: "Store an env-backed reference instead of plaintext",
        },
      ],
      initialValue: "plaintext",
    });
    if (tokenInputMode === "ref") {
      const envVar = await prompts.text({
        message: "Gateway token env var",
        initialValue: "OPENCLAW_GATEWAY_TOKEN",
        placeholder: "OPENCLAW_GATEWAY_TOKEN",
        validate: (value) => {
          const candidate = normalizeOptionalString(value) ?? "";
          if (!isValidEnvSecretRefId(candidate)) {
            return "Use an env var name like OPENCLAW_GATEWAY_TOKEN.";
          }
          const resolved = process.env[candidate]?.trim();
          if (!resolved) {
            return `Environment variable "${candidate}" is missing or empty in this session.`;
          }
          return undefined;
        },
      });
      const envVarName = normalizeOptionalString(envVar) ?? "";
      gatewayToken = createGatewayEnvSecretRef(cfg, envVarName);
      note(`Validated ${envVarName}. OpenClaw will store a token SecretRef.`, "Gateway token");
    } else {
      const tokenInput = await prompts.password({
        message: "Gateway token (blank to generate)",
      });
      gatewayTokenForCalls = normalizeGatewayTokenInput(tokenInput) || randomToken();
      gatewayToken = gatewayTokenForCalls;
    }
  }

  if (authMode === "password") {
    const passwordInput = await prompts.password({
      message: "Gateway password",
      validate: validateGatewayPasswordInput,
    });
    gatewayPassword = normalizeOptionalString(passwordInput) ?? "";
  }

  if (authMode === "trusted-proxy") {
    note(
      [
        "Trusted proxy mode: OpenClaw trusts user identity from a reverse proxy.",
        "The proxy must authenticate users and pass identity via headers.",
        "Only requests from specified proxy IPs will be trusted.",
        "",
        "Common use cases: Pomerium, Caddy + OAuth, Traefik + forward auth",
        "Docs: https://docs.openclaw.ai/gateway/trusted-proxy-auth",
      ].join("\n"),
      "Trusted Proxy Auth",
    );

    const userHeader = await prompts.text({
      message: "Header containing user identity",
      placeholder: "x-forwarded-user",
      initialValue: "x-forwarded-user",
      validate: (value) => (value?.trim() ? undefined : "User header is required"),
    });

    const requiredHeadersRaw = await prompts.text({
      message: "Required headers (comma-separated, optional)",
      placeholder: "x-forwarded-proto,x-forwarded-host",
    });
    const requiredHeaders = requiredHeadersRaw
      ? normalizeStringEntries(requiredHeadersRaw.split(","))
      : [];

    const allowUsersRaw = await prompts.text({
      message: "Allowed users (comma-separated, blank = all authenticated users)",
      placeholder: "nick@example.com,admin@company.com",
    });
    const allowUsers = allowUsersRaw ? normalizeStringEntries(allowUsersRaw.split(",")) : [];

    const trustedProxiesRaw = await prompts.text({
      message: "Trusted proxy IPs (comma-separated)",
      placeholder: "10.0.1.10,192.168.1.5",
      validate: (value) =>
        (value ?? "").split(",").every((address) => parseIpAddressOrCidr(address))
          ? undefined
          : "Enter comma-separated IPv4 or IPv6 addresses or CIDR ranges (e.g. 10.0.0.1, ::1, 10.0.0.0/24); no empty entries.",
    });
    trustedProxies = normalizeStringEntries(trustedProxiesRaw.split(","));

    const existingProxy =
      cfg.gateway?.auth?.mode === "trusted-proxy" ? cfg.gateway.auth.trustedProxy : undefined;
    let allowLoopback = existingProxy?.allowLoopback;
    // The base covers subnets within loopback; representative peers cover ranges containing it.
    // Use runtime matching too, including its mapped IPv4 and exact IPv6 zone semantics.
    if (
      trustedProxies.some((address) => {
        const base = parseIpAddressOrCidr(address)?.[0].toString();
        return [base, "127.0.0.1", "::1"].some(
          (peer) => isLoopbackAddress(peer) && isTrustedProxyAddress(peer, [address]),
        );
      })
    ) {
      const title = t("wizard.gateway.trustedProxyLoopbackTitle");
      note(t("wizard.gateway.trustedProxyLoopbackWarning"), title);
      allowLoopback =
        (await prompts.confirm({
          message: t("wizard.gateway.trustedProxyAllowLoopback"),
          initialValue: allowLoopback === true,
        })) || undefined;
      if (!allowLoopback) {
        note(t("wizard.gateway.trustedProxyLoopbackRefused"), title);
      }
    }

    trustedProxyConfig = {
      // Retain unprompted policy, including device enrollment, on same-mode reruns.
      ...existingProxy,
      userHeader: normalizeOptionalString(userHeader) ?? "",
      requiredHeaders: requiredHeaders.length > 0 ? requiredHeaders : undefined,
      allowUsers: allowUsers.length > 0 ? allowUsers : undefined,
      allowLoopback,
    };
  }

  const authConfig: GatewayAuthConfig = { ...next.gateway?.auth, mode: authMode };
  delete authConfig.token;
  delete authConfig.password;
  delete authConfig.trustedProxy;
  if (authMode === "token") {
    authConfig.token = gatewayToken;
  } else if (authMode === "password" && gatewayPassword) {
    authConfig.password = gatewayPassword;
  } else if (authMode === "trusted-proxy") {
    authConfig.trustedProxy = trustedProxyConfig;
  }

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      auth: authConfig,
      ...(customBindHost && { customBindHost }),
      ...(trustedProxies && { trustedProxies }),
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
      },
    },
  };

  next = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: next,
    tailscaleMode,
    tailscaleBin,
  });

  return { config: next, port, token: gatewayTokenForCalls };
}
