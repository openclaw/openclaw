import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";

export function extractQuickSettingsSecurity(root: Record<string, unknown>) {
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools);
  const exec = asConfigRecord(tools?.exec) ?? {};
  const browser = asConfigRecord(root.browser);
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    gatewayAuth = mode
      ? mode
      : auth.password
        ? "password"
        : auth.token
          ? "token"
          : auth.trustedProxy
            ? "trusted-proxy"
            : "none";
  }
  const profile = tools?.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    browserEnabled: browser?.enabled !== false,
    browserEnabledOverridden: browser !== null && Object.hasOwn(browser, "enabled"),
    toolProfile: typeof profile === "string" ? profile.trim() : "",
    toolProfileOverridden: tools !== null && Object.hasOwn(tools, "profile"),
  };
}
