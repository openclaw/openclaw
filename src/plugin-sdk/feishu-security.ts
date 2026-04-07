// Manual facade. Keep loader boundary explicit.
type SecuritySurface = typeof import("@openclaw/feishu/security-contract-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadSecuritySurface(): SecuritySurface {
  return loadBundledPluginPublicSurfaceModuleSync<SecuritySurface>({
    dirName: "feishu",
    artifactBasename: "security-contract-api.js",
  });
}

export const collectFeishuSecurityAuditFindings: SecuritySurface["collectFeishuSecurityAuditFindings"] =
  ((...args) =>
    loadSecuritySurface().collectFeishuSecurityAuditFindings(
      ...args,
    )) as SecuritySurface["collectFeishuSecurityAuditFindings"];
