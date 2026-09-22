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
        const previous = this.write;
        const accepted = field.onPatch(path, value);
        // Nested drafts may accept an edit without publishing a complete value.
        // Only the flush captured by this edit can acknowledge its persistence.
        return accepted !== false && this.write && this.write !== previous ? this.write : false;
      },
    });
  };
}
