import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import {
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
} from "../gateway/gateway-config-prompts.shared.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import { note } from "../terminal/note.js";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";
import { confirm, select, text } from "./configure.shared.js";
import {
  guardCancel,
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";

export async function promptGatewayConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: OpenClawConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      message: "Gateway port",
      initialValue: String(resolveGatewayPort(cfg)),
      validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
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
          hint: "Bind to your Tailscale IP only (100.x.x.x)",
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
          hint: "Specify a specific IP address, with 0.0.0.0 fallback if unavailable",
        },
      ],
    }),
    runtime,
  );

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = guardCancel(
      await text({
        message: "Custom IP address",
        placeholder: "192.168.1.100",
        validate: validateIPv4AddressInput,
      }),
      runtime,
    );
    customBindHost = typeof input === "string" ? input : undefined;
  }

  let authMode = guardCancel(
    await select({
      message: "Gateway auth",
      options: [
        { value: "token", label: "Token", hint: "Recommended default" },
        { value: "password", label: "Password" },
        {
          value: "trusted-proxy",
          label: "Trusted Proxy",
          hint: "Behind reverse proxy (Pomerium, Caddy, Traefik, etc.)",
        },
      ],
      initialValue: "token",
    }),
    runtime,
  ) as GatewayAuthChoice;

  let tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [...TAILSCALE_EXPOSURE_OPTIONS],
    }),
    runtime,
  );

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
    }
  }

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: "Reset Tailscale serve/funnel on exit?",
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
    bind = "loopback";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  if (authMode === "trusted-proxy" && bind === "loopback") {
    note("Trusted proxy auth requires network bind. Adjusting bind to lan.", "Note");
    bind = "lan";
  }
  if (authMode === "trusted-proxy" && tailscaleMode !== "off") {
    note(
      "Trusted proxy auth is incompatible with Tailscale serve/funnel. Disabling Tailscale.",
      "Note",
    );
    tailscaleMode = "off";
    tailscaleResetOnExit = false;
  }

  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;
  let trustedProxyConfig:
    | { userHeader: string; requiredHeaders?: string[]; allowUsers?: string[] }
    | undefined;
  let trustedProxies: string[] | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "Gateway token (blank to generate)",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: validateGatewayPasswordInput,
      }),
      runtime,
    );
    gatewayPassword = String(password ?? "").trim();
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

    const userHeader = guardCancel(
      await text({
        message: "Header containing user identity",
        placeholder: "x-forwarded-user",
        initialValue: "x-forwarded-user",
        validate: (value) => (value?.trim() ? undefined : "User header is required"),
      }),
      runtime,
    );

    const requiredHeadersRaw = guardCancel(
      await text({
        message: "Required headers (comma-separated, optional)",
        placeholder: "x-forwarded-proto,x-forwarded-host",
      }),
      runtime,
    );
    const requiredHeaders = requiredHeadersRaw
      ? String(requiredHeadersRaw)
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean)
      : [];

    const allowUsersRaw = guardCancel(
      await text({
        message: "Allowed users (comma-separated, blank = all authenticated users)",
        placeholder: "nick@example.com,admin@company.com",
      }),
      runtime,
    );
    const allowUsers = allowUsersRaw
      ? String(allowUsersRaw)
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean)
      : [];

    const trustedProxiesRaw = guardCancel(
      await text({
        message: "Trusted proxy IPs (comma-separated)",
        placeholder: "10.0.1.10,192.168.1.5",
        validate: (value) => {
          if (!value || String(value).trim() === "") {
            return "At least one trusted proxy IP is required";
          }
          return undefined;
        },
      }),
      runtime,
    );
    trustedProxies = String(trustedProxiesRaw)
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);

    trustedProxyConfig = {
      userHeader: String(userHeader).trim(),
      requiredHeaders: requiredHeaders.length > 0 ? requiredHeaders : undefined,
      allowUsers: allowUsers.length > 0 ? allowUsers : undefined,
    };
  }

  const authConfig = buildGatewayAuthConfig({
    existing: next.gateway?.auth,
    mode: authMode,
    token: gatewayToken,
    password: gatewayPassword,
    trustedProxy: trustedProxyConfig,
  });

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
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}
