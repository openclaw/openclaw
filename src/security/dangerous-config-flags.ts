import type { OpenClawConfig } from "../config/config.js";

/**
 * Return a list of config key=value strings for every dangerous or insecure
 * flag that is currently enabled in the supplied config.
 *
 * **Security note — `allowUnsafeExternalContent`:**
 * When `hooks.gmail.allowUnsafeExternalContent` or
 * `hooks.mappings[].allowUnsafeExternalContent` is `true`, the injection
 * scanner hard-stop is disabled for that hook source.  Incoming content will
 * not be blocked for injection attempts; the agent processes it as if it were
 * fully trusted.  This is a significant security regression — a malicious
 * email or webhook payload can use prompt-injection to manipulate tool calls,
 * exfiltrate data, or escalate privileges.  Enable only when the source is an
 * authenticated internal service with no user-controlled input, and only after
 * independent security review.  See `docs/security/best-practices.md` for the
 * full risk description.
 *
 * This function is called by the security audit and the doctor health check to
 * surface enabled dangerous flags as findings.
 */
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
  return enabledFlags;
}
