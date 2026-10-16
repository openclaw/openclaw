import type { ApplicationContext } from "../../app/context.ts";
import type {
  PluginCredentialEditorContext,
  PluginCredentialEditorProps,
} from "./credential-editor.tsx";
import type { PluginsPageDetail } from "./plugins-page-model.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";

export function createPluginSettings(options: {
  gateway: PluginCredentialEditorContext["gateway"];
  getContext: () => ApplicationContext;
  getDetail: () => PluginsPageDetail | null;
  canInspect: () => boolean;
  canEdit: () => boolean;
  onEdit: () => void;
  isSettings: () => boolean;
}) {
  let write: Promise<boolean> | undefined;
  const patch = (path: Array<string | number>, value: unknown): boolean => {
    if (!options.canEdit()) {
      return false;
    }
    options.onEdit();
    const runtime = options.getContext().runtimeConfig;
    if (value === undefined) {
      runtime.removeFormValue(path);
    } else {
      runtime.patchForm(path, value);
    }
    if (options.getDetail() && options.isSettings()) {
      write = runtime.flushFormChanges();
    }
    return true;
  };

  const resolveCredential = (
    field: PluginSettingsField,
  ): PluginCredentialEditorProps | undefined => {
    const detail = options.getDetail();
    const descriptor = detail?.inspection?.credentials?.find(
      (entry) =>
        entry.path.length === field.path.length &&
        entry.path.every((segment, index) => segment === field.path[index]),
    );
    if (!detail || !descriptor) {
      return undefined;
    }
    const runtime = options.getContext().runtimeConfig;
    return {
      field,
      descriptor,
      context: {
        pluginId: detail.pluginId,
        baseHash: runtime.state.configSnapshot?.hash ?? null,
        gateway: options.gateway,
        canInspect: options.canInspect(),
        saveError: runtime.state.lastError,
        onDiscard: () => runtime.discardFormValue(field.path),
        onCommit: async (path, value) => {
          const previous = write;
          const accepted = field.onPatch(path, value);
          // Nested drafts may accept an edit without publishing a complete value.
          // Only the flush captured by this edit can acknowledge its persistence.
          return accepted !== false && write && write !== previous ? write : false;
        },
      },
    };
  };
  return { patch, resolveCredential };
}
