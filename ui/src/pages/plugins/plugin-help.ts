import { onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type {
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
  type PluginHelpReference,
} from "../custodian/plugin-help.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";

/** The page publishes its loaded selection; the existing Ask store owns conversation state. */
export function createPluginHelp(context: ApplicationContext) {
  let plugin: PluginHelpReference | undefined;
  let release: (() => void) | undefined;

  onCleanup(() => {
    release?.();
    plugin = undefined;
  });
  const help = {
    get available(): boolean {
      return plugin !== undefined;
    },

    update(model: {
      connected: boolean;
      result: PluginListResult | null;
      detail: {
        pluginId: string;
        inspection?: PluginsInspectResult | null;
        catalog?: PluginDiscoveryDetailResult;
      } | null;
      catalogDetail: { result: PluginDiscoveryDetailResult | null } | null;
    }): void {
      const installed = model.result?.plugins.find(
        (candidate) => candidate.installed && candidate.id === model.detail?.pluginId,
      );
      const catalog = model.detail?.catalog ?? model.catalogDetail?.result;
      const catalogPluginId = catalog?.plugin.local.pluginId ?? catalog?.detail.packageName;
      const declared = catalog
        ? {
            tools: catalog.detail.contracts?.tools,
            providers: catalog.detail.providers,
            channels: catalog.detail.channels,
            contracts: catalog.detail.contracts
              ? Object.entries(catalog.detail.contracts)
                  .filter(([family]) => family !== "tools")
                  .flatMap(([family, ids]) => ids.map((id) => `${family}: ${id}`))
              : undefined,
            skills: catalog.detail.skills.map((skill) => skill.name),
            mcpServers: catalog.detail.mcpServers,
          }
        : undefined;
      plugin =
        model.connected &&
        canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin")
          ? installed
            ? {
                id: installed.id,
                name: installed.name,
                declared:
                  model.detail?.inspection?.declared ??
                  (installed.catalogId === catalog?.plugin.id ? declared : undefined),
              }
            : catalog && catalogPluginId
              ? { id: catalogPluginId, name: catalog.plugin.catalog.name, declared }
              : undefined
          : undefined;
      if (!plugin) {
        release?.();
        release = undefined;
        return;
      }
      // Each release is tied to its publication; a retiring page cannot clear a newer page.
      release = publishPluginHelpContext(context, help, plugin, { installed: Boolean(installed) });
    },

    get ask(): (field?: PluginSettingsField) => Promise<void> {
      if (!plugin) {
        return async () => {};
      }
      const request = createPluginHelpRequest(context, plugin);
      return (field) => {
        const value = field?.value === undefined ? field?.schema.default : field.value;
        return request(
          field
            ? {
                path: field.path,
                label: field.label,
                value,
                sensitive: hasSensitiveConfigData(value, field.path, field.hints),
              }
            : undefined,
        );
      };
    },
  };
  return help;
}
