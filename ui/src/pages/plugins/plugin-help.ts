import {
  normalizeSystemAgentPluginReference,
  type SystemAgentPluginReference,
} from "@openclaw/gateway-protocol/system-agent-context";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { captureHomeHelpTarget, openHomeHelp } from "../../app/home-help.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type {
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { showToast } from "../../lib/toast.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";

registerPluginManagementEnglish();

/** The page contributes a bounded reference; the regular Home composer owns the question. */
export function createPluginHelp(context: ApplicationContext) {
  let plugin: SystemAgentPluginReference | undefined;
  let active = true;
  onSettled(() => () => {
    active = false;
    plugin = undefined;
  });
  return {
    get available() {
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
    }) {
      const installed = model.result?.plugins.find(
        (candidate) => candidate.installed && candidate.id === model.detail?.pluginId,
      );
      const catalog = model.detail?.catalog ?? model.catalogDetail?.result;
      const id = installed?.id ?? catalog?.plugin.local.pluginId ?? catalog?.detail.packageName;
      const declared =
        model.detail?.inspection?.declared ??
        (catalog
          ? {
              tools: catalog.detail.contracts?.tools,
              providers: catalog.detail.providers,
              channels: catalog.detail.channels,
              contracts: catalog.detail.contracts
                ? Object.entries(catalog.detail.contracts)
                    .filter(([family]) => family !== "tools")
                    .flatMap(([family, ids]) => ids.map((item) => family + ": " + item))
                : undefined,
              skills: catalog.detail.skills.map((skill) => skill.name),
              mcpServers: catalog.detail.mcpServers,
            }
          : undefined);
      const next =
        active &&
        model.connected &&
        canCallGatewayMethod(context.gateway.snapshot, "chat.send", "operator.write") &&
        id
          ? normalizeSystemAgentPluginReference({
              id,
              name: installed?.name ?? catalog?.plugin.catalog.name,
              installed: Boolean(installed),
              declared,
            })
          : undefined;
      // Keep a rendered action valid across same-selection data refreshes.
      if (JSON.stringify(next) !== JSON.stringify(plugin)) {
        plugin = next;
      }
    },
    get ask(): (field?: PluginSettingsField) => Promise<void> {
      const selected = plugin;
      const target = captureHomeHelpTarget(context);
      const pathname = context.router.getState().location.pathname;
      const current = () =>
        active &&
        selected !== undefined &&
        plugin === selected &&
        target.isCurrent() &&
        context.router.getState().location.pathname === pathname;
      return async (field) => {
        if (!current() || !selected) {
          return;
        }
        try {
          const { formatPluginHelpValue } = await import("./plugin-help-value.ts");
          if (!current()) {
            return;
          }
          const value = field?.value === undefined ? field?.schema.default : field.value;
          const reference = normalizeSystemAgentPluginReference({
            ...selected,
            ...(field
              ? {
                  setting: {
                    path: field.path.map(String),
                    label: truncateUtf16Safe(field.label, 96),
                  },
                }
              : {}),
          });
          const question = field
            ? t("custodian.pluginHelpQuestion", { setting: truncateUtf16Safe(field.label, 96) }) +
              "\n\n" +
              t("custodian.pluginHelpValue", {
                value: formatPluginHelpValue(
                  value,
                  hasSensitiveConfigData(value, field.path, field.hints),
                ),
              })
            : t("pluginsPage.helpQuestion", { plugin: selected.name ?? selected.id });
          // All generated context is visible and editable before Send. No README,
          // configuration body, authentication value or machine-wide history is attached.
          openHomeHelp(
            context,
            target,
            question +
              "\n\n" +
              t("pluginsPage.helpReference") +
              "\n" +
              JSON.stringify(reference, (_key, item: unknown) =>
                Array.isArray(item) && item.length === 0 ? undefined : item,
              ),
          );
        } catch {
          if (current()) {
            showToast({ severity: "error", message: t("custodian.pluginHelpFailed") });
          }
        }
      };
    },
  };
}
