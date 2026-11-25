// Doctor repair for configs that reuse Gateway shared-secret auth as hooks.token.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  canMaterializeGatewayAuthSecretRefsWithoutExec,
  materializeGatewayAuthSecretRefs,
} from "../../../gateway/auth-config-utils.js";
import { resolveGatewayAuth } from "../../../gateway/auth.js";
import { randomToken } from "../../random-token.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

/** Rotate hooks.token when it matches the active Gateway token/password shared secret. */
export async function repairHooksTokenReuseGatewayAuth(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  createToken: () => string = randomToken,
): Promise<DoctorConfigMutationResult> {
  const hooksToken = normalizeOptionalString(cfg.hooks?.token) ?? "";
  if (cfg.hooks?.enabled !== true || !hooksToken) {
    return { config: cfg, changes: [] };
  }

  const materializeParams = {
    cfg,
    env,
    mode: cfg.gateway?.auth?.mode,
    hasTokenOverride: false,
    hasPasswordOverride: false,
    hasTokenFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
    hasPasswordFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
  };
  const materializedCfg = await (canMaterializeGatewayAuthSecretRefsWithoutExec(materializeParams)
    ? materializeGatewayAuthSecretRefs(materializeParams).catch(() => cfg)
    : cfg);
  const auth = resolveGatewayAuth({
    authConfig: materializedCfg.gateway?.auth,
    tailscaleMode: materializedCfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const sharedSecret =
    auth.mode === "token"
      ? auth.token
      : auth.mode === "password" || auth.mode === "trusted-proxy"
        ? auth.password
        : undefined;
  if (hooksToken !== (normalizeOptionalString(sharedSecret) ?? "")) {
    return { config: cfg, changes: [] };
  }

  const nextHooksToken = createToken();
  return {
    config: {
      ...cfg,
      hooks: {
        ...cfg.hooks,
        token: nextHooksToken,
      },
    },
    changes: [
      "Rotated hooks.token because it reused active Gateway shared-secret auth. Update external hook senders to use the new hooks.token.",
    ],
  };
}
