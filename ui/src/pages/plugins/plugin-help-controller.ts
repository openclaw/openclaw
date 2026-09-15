import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
  type PluginHelpReference,
} from "../custodian/plugin-help.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import type { PluginSettingsField } from "./settings-editor.ts";

/** The page publishes its loaded selection; the existing Ask store owns conversation state. */
export class PluginHelpController implements ReactiveController {
  private context?: ApplicationContext;
  private plugin?: PluginHelpReference;
  private release?: () => void;

  constructor(host: ReactiveControllerHost) {
    host.addController(this);
  }

  get available(): boolean {
    return this.plugin !== undefined;
  }

  update(model: {
    context: ApplicationContext;
    connected: boolean;
    result: PluginListResult | null;
    detail: { pluginId: string } | null;
    catalogDetail: { result: PluginDiscoveryDetailResult | null } | null;
    installedDetailTab: InstalledPluginDetailTab;
  }): void {
    const context = model.context;
    if (context !== this.context) {
      this.release?.();
      this.context = context;
    }
    const installed = model.result?.plugins.find(
      (plugin) => plugin.installed && plugin.id === model.detail?.pluginId,
    );
    const catalog = model.catalogDetail?.result;
    const catalogPluginId = catalog?.plugin.local.pluginId ?? catalog?.detail.packageName;
    this.plugin =
      model.connected &&
      canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin")
        ? installed
          ? { id: installed.id, name: installed.name }
          : catalog && catalogPluginId
            ? { id: catalogPluginId, name: catalog.plugin.catalog.name }
            : undefined
        : undefined;
    if (!this.plugin) {
      this.release?.();
      this.release = undefined;
      return;
    }
    // Each release is tied to its publication; a retiring page cannot clear a newer page.
    this.release = publishPluginHelpContext(context, this, this.plugin, {
      installed: Boolean(installed),
      overview: !installed || model.installedDetailTab !== "configuration",
    });
  }

  get ask(): (field?: PluginSettingsField) => Promise<void> {
    if (!this.context || !this.plugin) {
      return async () => {};
    }
    const request = createPluginHelpRequest(this.context, this.plugin);
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
  }

  hostDisconnected(): void {
    this.release?.();
    this.release = undefined;
    this.plugin = undefined;
  }
}
