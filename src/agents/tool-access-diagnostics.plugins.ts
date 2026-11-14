import type { ToolAccessDiagnostics } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { explainToolPolicyAvailability } from "./tool-availability-explanation.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

/** Complete the preview without loading runtimes that selection intentionally skipped. */
export function appendDeclaredPluginToolAccess(params: {
  diagnostics: ToolAccessDiagnostics;
  config: OpenClawConfig;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  metadataSnapshot: PluginMetadataSnapshot | undefined;
}): void {
  const snapshot = params.metadataSnapshot;
  if (!snapshot || params.config.plugins?.enabled === false) {
    return;
  }
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const seen = new Set(params.diagnostics.tools.map((tool) => tool.id));
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
        normalizedConfig,
      })
    ) {
      continue;
    }
    const toolNames = (plugin.contracts?.tools ?? []).filter(
      (name) => !seen.has(normalizeToolPolicyName(name)),
    );
    if (toolNames.length === 0) {
      continue;
    }
    // Real ownership lets the existing policy owner expand plugin IDs and group:plugins.
    const availability = explainToolPolicyAvailability({
      config: params.config,
      conversationCapabilityProfile: params.capabilityProfile,
      pluginId: plugin.id,
      toolNames,
    });
    for (const tool of availability) {
      const id = normalizeToolPolicyName(tool.name);
      seen.add(id);
      if (tool.available) {
        params.diagnostics.tools.push({
          id,
          status: "unavailable",
          reasons: [
            {
              kind: "runtime",
              label:
                "Declared by plugin but absent from the session preview; construction and runtime health are not confirmed",
            },
          ],
        });
      } else {
        const { block } = tool;
        const kind =
          block.stage === "deny"
            ? "deny"
            : block.stage === "profile" ||
                (block.stage === "provider-policy" && block.source?.endsWith(".profile"))
              ? "profile"
              : block.stage === "session"
                ? "session"
                : "allowlist";
        params.diagnostics.tools.push({
          id,
          status: "excluded",
          reasons: [
            {
              kind,
              label: block.detail + " " + block.fix,
              ...(block.source ? { source: block.source } : {}),
            },
          ],
        });
      }
    }
  }
}
