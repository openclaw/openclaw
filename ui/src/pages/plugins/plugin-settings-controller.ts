import type { ApplicationContext } from "../../app/context.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { renderPluginCredential } from "./credential-editor.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";
import type { PluginSettingsField } from "./settings-editor.ts";

export class PluginSettingsController {
  private write: Promise<boolean> | undefined;

  constructor(
    private readonly options: {
      gateway: GatewayPageController;
      getContext: () => ApplicationContext;
      getDetail: () => PluginsPageDetail | null;
      canInspect: () => boolean;
      canEdit: () => boolean;
      onEdit: () => void;
      isSettings: () => boolean;
    },
  ) {}

  readonly patch = (path: Array<string | number>, value: unknown): boolean => {
    if (!this.options.canEdit()) {
      return false;
    }
    this.options.onEdit();
    const runtime = this.options.getContext().runtimeConfig;
    if (value === undefined) {
      runtime.removeFormValue(path);
    } else {
      runtime.patchForm(path, value);
    }
    if (this.options.getDetail() && this.options.isSettings()) {
      this.write = runtime.flushFormChanges();
    }
    return true;
  };

  readonly render = (field: PluginSettingsField) => {
    const detail = this.options.getDetail();
    const descriptor = detail?.inspection?.credentials?.find(
      (entry) =>
        entry.path.length === field.path.length &&
        entry.path.every((segment, index) => segment === field.path[index]),
    );
    if (!detail || !descriptor) {
      return undefined;
    }
    const runtime = this.options.getContext().runtimeConfig;
    return renderPluginCredential(field, descriptor, {
      pluginId: detail.pluginId,
      baseHash: runtime.state.configSnapshot?.hash ?? null,
      gateway: this.options.gateway,
      canInspect: this.options.canInspect(),
      saveError: runtime.state.lastError,
      onDiscard: () => runtime.discardFormValue(field.path),
      onCommit: async (path, value) => {
        if (descriptor.storage === "protected" && typeof value === "string") {
          const connection = this.options.gateway.capture();
          if (!connection) {
            return false;
          }
          const result = await runtime.runExternalMutation(
            (client) => {
              const baseHash = runtime.state.configSnapshot?.hash;
              if (!baseHash) {
                throw new Error(
                  "Configuration is unavailable; reload Settings before saving the credential.",
                );
              }
              return client.request<{ saved: true; warning?: string }>("plugins.credentials.set", {
                pluginId: detail.pluginId,
                path,
                baseHash,
                value,
              });
            },
            {
              canDispatch: () =>
                this.options.canEdit() &&
                this.options.isSettings() &&
                this.options.getDetail() === detail &&
                this.options.gateway.isCurrent(connection),
            },
          );
          if (!result.ok) {
            throw new Error(result.error);
          }
          const warning = [
            result.value.warning,
            !result.refresh.ok ? result.refresh.error : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          return { saved: true, ...(warning ? { warning } : {}) };
        }
        const previous = this.write;
        const accepted = field.onPatch(path, value);
        // Nested drafts may accept an edit without publishing a complete value.
        // Only the flush captured by this edit can acknowledge its persistence.
        return accepted !== false && this.write && this.write !== previous ? this.write : false;
      },
    });
  };
}
