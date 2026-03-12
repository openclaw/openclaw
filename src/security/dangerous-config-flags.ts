import type { OpenClawConfig } from "../config/config.js";

export function collectEnabledInsecureOrDangerousFlags(cfg: OpenClawConfig): string[] {
  const enabledFlags: string[] = [];
  if (cfg.gateway?.controlUi?.allowInsecureAuth === true) {
    enabledFlags.push("gateway.controlUi.allowInsecureAuth=true");
  }
  if (cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    enabledFlags.push("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true");
  }
  if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    enabledFlags.push("gateway.controlUi.dangerouslyDisableDeviceAuth=true");
  }
  if (cfg.hooks?.gmail?.allowUnsafeExternalContent === true) {
    enabledFlags.push("hooks.gmail.allowUnsafeExternalContent=true");
  }
  if (Array.isArray(cfg.hooks?.mappings)) {
    for (const [index, mapping] of cfg.hooks.mappings.entries()) {
      if (mapping?.allowUnsafeExternalContent === true) {
        enabledFlags.push(`hooks.mappings[${index}].allowUnsafeExternalContent=true`);
      }
    }
  }
  if (cfg.tools?.exec?.applyPatch?.workspaceOnly === false) {
    enabledFlags.push("tools.exec.applyPatch.workspaceOnly=false");
  }
  // [HARDENED] mode=none disables authentication entirely — flag as dangerous.
  if (cfg.gateway?.auth?.mode === "none") {
    enabledFlags.push("gateway.auth.mode=none (authentication fully disabled)");
  }
  // [HARDENED] trusted-proxy with an empty allowUsers list accepts ALL proxy users.
  if (
    cfg.gateway?.auth?.mode === "trusted-proxy" &&
    Array.isArray(cfg.gateway?.auth?.trustedProxy?.allowUsers) &&
    cfg.gateway.auth.trustedProxy.allowUsers.length === 0
  ) {
    enabledFlags.push(
      "gateway.auth.trustedProxy.allowUsers=[] (all proxy-authenticated users accepted)",
    );
  }
  return enabledFlags;
}
