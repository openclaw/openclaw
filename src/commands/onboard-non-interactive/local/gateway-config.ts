// setupWizardCommand admits option syntax before dispatch. Checks here depend
// on saved configuration or the environment at application time.
import { validateDottedDecimalIPv4Input } from "@openclaw/net-policy/ipv4";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSecretInputRef } from "../../../config/types.secrets.js";
import { provisionGatewayTokenStoreRef } from "../../../gateway/auth-token-store-ref.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createGatewayEnvSecretRef } from "../../../secrets/ref-contract.js";
import { normalizeGatewayTokenInput, randomToken } from "../../onboard-helpers.js";
import { rejectOnboardingOption } from "../../onboard-options.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Applies gateway CLI options to the pending config and returns normalized runtime settings. */
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
} | null {
  const { opts, runtime } = params;

  const existingGateway = params.nextConfig.gateway;
  const port = opts.gatewayPort ?? params.defaultPort;
  let bind = opts.gatewayBind ?? existingGateway?.bind ?? "loopback";
  const explicitAuthMode = opts.gatewayAuth;
  const hasExplicitTokenAuthInput =
    opts.gatewayToken !== undefined || opts.gatewayTokenRefEnv !== undefined;
  let authMode =
    explicitAuthMode ??
    (hasExplicitTokenAuthInput
      ? "token"
      : opts.gatewayPassword !== undefined
        ? "password"
        : existingGateway?.auth?.mode) ??
    "token";
  const tailscaleMode = opts.tailscale ?? existingGateway?.tailscale?.mode ?? "off";

  // Tighten config to safe combos:
  // - If Tailscale is on, force loopback bind (the tunnel handles external access).
  // - If using Tailscale Funnel, require password auth.
  // Preserve an existing combination on unrelated reruns; only normalize when
  // the operator is changing one of the fields that participates in the rule.
  const changesBindOrTailscale = opts.gatewayBind !== undefined || opts.tailscale !== undefined;
  if (changesBindOrTailscale && tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }

  // bind=custom is only startable alongside a valid gateway.customBindHost, and the non-interactive
  // path has no prompt to collect one. Checked after the Tailscale normalization above so a bind
  // forced back to loopback never trips it. Without this, setup writes a config the Gateway refuses.
  if (bind === "custom") {
    const customBindHostIssue = validateDottedDecimalIPv4Input(
      normalizeOptionalString(existingGateway?.customBindHost ?? ""),
    );
    if (customBindHostIssue) {
      const setCommand = formatCliCommand("openclaw config set gateway.customBindHost <ipv4>");
      const interactiveCommand = formatCliCommand("openclaw onboard");
      rejectOnboardingOption(
        opts,
        runtime,
        `--gateway-bind custom requires gateway.customBindHost: ${customBindHostIssue}. Set it with ${setCommand} and rerun, or run ${interactiveCommand} interactively to be prompted for it.`,
      );
      return null;
    }
  }
  const changesAuthOrTailscale =
    explicitAuthMode !== undefined || hasExplicitTokenAuthInput || opts.tailscale !== undefined;
  if (changesAuthOrTailscale && tailscaleMode === "serve" && authMode === "none") {
    authMode = "token";
  }
  if (changesAuthOrTailscale && tailscaleMode === "funnel" && authMode !== "password") {
    if (authMode === "trusted-proxy") {
      rejectOnboardingOption(
        opts,
        runtime,
        'Tailscale Funnel requires password auth, but the Gateway is configured with "trusted-proxy" auth. ' +
          "Re-run with --gateway-auth password to switch, or keep Tailscale exposure off.",
      );
      return null;
    }
    authMode = "password";
  }

  const nextConfig = params.nextConfig;
  let auth = existingGateway?.auth;
  const explicitGatewayToken = normalizeGatewayTokenInput(opts.gatewayToken);
  const envGatewayToken = normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
  const existingTokenInput = nextConfig.gateway?.auth?.token;
  const existingTokenRef = resolveSecretInputRef({
    value: existingTokenInput,
    defaults: nextConfig.secrets?.defaults,
  }).ref;
  const existingPlaintextToken = normalizeGatewayTokenInput(existingTokenInput);
  // Resolution order on re-onboard: explicit --gateway-token > persisted
  // plaintext > ambient OPENCLAW_GATEWAY_TOKEN > randomToken(). Ambient env
  // must not rotate a token already written to disk — a stale shell or
  // launchd env var otherwise breaks already-paired clients.
  const gatewayToken =
    explicitGatewayToken || existingPlaintextToken || envGatewayToken || undefined;
  const gatewayTokenRefEnv = normalizeOptionalString(opts.gatewayTokenRefEnv ?? "") ?? "";

  if (authMode === "token") {
    auth = { ...auth, mode: "token" };
    if (gatewayTokenRefEnv) {
      const resolvedFromEnv = process.env[gatewayTokenRefEnv]?.trim();
      if (!resolvedFromEnv) {
        rejectOnboardingOption(
          opts,
          runtime,
          `Environment variable "${gatewayTokenRefEnv}" is missing or empty. Export it first, then rerun ${formatCliCommand("openclaw onboard --non-interactive")}.`,
        );
        return null;
      }
      auth.token = createGatewayEnvSecretRef(nextConfig, gatewayTokenRefEnv);
    } else if (explicitGatewayToken || !existingTokenRef) {
      // Preserve configured refs unless an explicit token replaces them. Reference
      // mode keeps ambient tokens rotatable via their env ref; values held by
      // setup itself belong in the shared secret store.
      if (opts.secretInputMode !== "ref") {
        auth.token = gatewayToken ?? randomToken();
      } else if (!explicitGatewayToken && !existingPlaintextToken && envGatewayToken) {
        auth.token = createGatewayEnvSecretRef(nextConfig, "OPENCLAW_GATEWAY_TOKEN");
      } else {
        auth.token = provisionGatewayTokenStoreRef({
          config: nextConfig,
          ...(gatewayToken ? { token: gatewayToken } : {}),
        }).ref;
      }
    }
  }

  if (authMode === "password") {
    const input = opts.gatewayPassword;
    const password =
      input === undefined
        ? (nextConfig.gateway?.auth?.password ??
          normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD))
        : normalizeOptionalString(input);
    if (!password) {
      rejectOnboardingOption(
        opts,
        runtime,
        "Missing --gateway-password for password auth. Pass --gateway-password or use --gateway-auth token.",
      );
      return null;
    }
    auth = {
      ...auth,
      mode: "password",
      ...(input !== undefined
        ? {
            password:
              opts.secretInputMode === "ref"
                ? createGatewayEnvSecretRef(nextConfig, "OPENCLAW_GATEWAY_PASSWORD")
                : password,
          }
        : {}),
    };
  }

  return {
    nextConfig: {
      ...nextConfig,
      gateway: {
        ...existingGateway,
        ...(auth ? { auth } : {}),
        port,
        bind,
        tailscale: {
          ...existingGateway?.tailscale,
          mode: tailscaleMode,
        },
      },
    },
    port,
    bind,
    authMode,
    tailscaleMode,
  };
}
