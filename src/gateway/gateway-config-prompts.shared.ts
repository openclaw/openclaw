import { isIpv6Address, parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatPortRangeHint } from "../cli/error-format.js";
import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { parseTcpPort } from "../infra/tcp-port.js";

export function validateGatewayPortInput(value: unknown): string | undefined {
  return parseTcpPort(value) === null ? formatPortRangeHint() : undefined;
}

export const TAILSCALE_EXPOSURE_OPTIONS = [
  { value: "off", label: "Off", hint: "No Tailscale exposure" },
  {
    value: "serve",
    label: "Serve",
    hint: "Private HTTPS for your tailnet (devices on Tailscale)",
  },
  {
    value: "funnel",
    label: "Funnel",
    hint: "Public HTTPS via Tailscale Funnel (internet)",
  },
] as const;

export const TAILSCALE_MISSING_BIN_NOTE_LINES = [
  "Tailscale binary not found in PATH or /Applications.",
  "Install Tailscale from:",
  "  https://tailscale.com/download/mac",
  "",
  "You can continue setup, but serve/funnel will fail at runtime.",
] as const;

export const TAILSCALE_DOCS_LINES = [
  "Docs:",
  "https://docs.openclaw.ai/gateway/tailscale",
  "https://docs.openclaw.ai/web",
] as const;

function buildTailnetHttpsOrigin(rawHost: string): string | null {
  const trimmed = rawHost.trim().replace(/\.$/, "");
  if (!trimmed) {
    return null;
  }
  const parsed = parseCanonicalIpAddress(trimmed);
  const normalizedHost =
    parsed && isIpv6Address(parsed)
      ? `[${normalizeLowercaseStringOrEmpty(parsed.toString())}]`
      : trimmed;
  return URL.parse(`https://${normalizedHost}`)?.origin ?? null;
}

export async function maybeAddTailnetOriginToControlUiAllowedOrigins(params: {
  config: OpenClawConfig;
  tailscaleMode: string;
  tailscaleBin?: string | null;
}): Promise<OpenClawConfig> {
  if (params.tailscaleMode !== "serve" && params.tailscaleMode !== "funnel") {
    return params.config;
  }
  const tsOrigin = await getTailnetHostname(undefined, params.tailscaleBin ?? undefined)
    .then((host) =>
      buildTailnetHttpsOrigin(expectDefined(host, "gateway config prompts.shared host")),
    )
    .catch(() => null);
  if (!tsOrigin) {
    return params.config;
  }

  const existing = resolveControlUiAllowedOrigins(params.config) ?? [];
  const normalized = normalizeLowercaseStringOrEmpty(tsOrigin);
  if (existing.some((entry) => normalizeLowercaseStringOrEmpty(entry) === normalized)) {
    return params.config;
  }
  // Preserve all unrelated gateway/controlUi config while adding the derived
  // tailnet origin, because setup writes partial gateway config objects.
  return {
    ...params.config,
    gateway: {
      ...params.config.gateway,
      controlUi: {
        ...params.config.gateway?.controlUi,
        allowedOrigins: [...existing, tsOrigin],
      },
    },
  };
}
