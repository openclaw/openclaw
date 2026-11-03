import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type {
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginSecurityAuditContext,
} from "../plugins/plugin-registration.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { loadPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import type { SecurityAuditFinding } from "./audit.types.js";

/** Plain audit loads only declared config collectors, never plugin runtime entrypoints. */
export async function collectPluginConfigSecurityAuditFindings(
  context: OpenClawPluginSecurityAuditContext & { workspaceDir?: string },
): Promise<SecurityAuditFinding[]> {
  const { plugins } = loadPluginManifestRegistryForPluginRegistry({
    config: context.config,
    env: context.env,
    workspaceDir: context.workspaceDir,
  });
  const normalizedConfig = normalizePluginsConfig(context.config.plugins);
  const findings: SecurityAuditFinding[] = [];
  for (const plugin of plugins) {
    if (
      plugin.securityAuditConfig !== true ||
      !isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: context.config })
    ) {
      continue;
    }
    try {
      if (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) {
        throw new Error("config audit requires a bundled or verified official plugin");
      }
      const api = loadPluginPublicArtifactModuleSync<{
        collectConfigSecurityAuditFindings?: OpenClawPluginSecurityAuditCollector;
      }>({
        pluginRoot: plugin.rootDir,
        artifactBasename: "security-audit-api.js",
        origin: plugin.origin === "bundled" ? "bundled" : "global",
      });
      if (typeof api.collectConfigSecurityAuditFindings !== "function") {
        throw new Error(
          "declared security-audit-api.js is missing collectConfigSecurityAuditFindings",
        );
      }
      findings.push(...(await api.collectConfigSecurityAuditFindings(context)));
    } catch (error) {
      findings.push({
        checkId: `plugins.${plugin.id}.config_security_audit_failed`,
        severity: "warn",
        title: "Plugin config security audit failed",
        detail: `${plugin.id}: ${String(error)}`,
      });
    }
  }
  return findings;
}
