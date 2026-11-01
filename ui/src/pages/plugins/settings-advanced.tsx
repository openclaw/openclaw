import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsEmpty, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginManager } from "../../plugins/control-ui-manager.solid.tsx";
import { PluginSettingsReadStatus } from "./settings-read-status.tsx";
import { PluginRetryError } from "./settings-retry-error.tsx";
import type { InventoryProps } from "./settings-view.tsx";

function AdvancedSettingsFields(options: InventoryProps): JSX.Element {
  const config = createMemo(() => {
    const schema = options.advancedSchema;
    const value = options.configValue;
    return schema && value ? { schema, value } : null;
  });
  return (
    <Show
      when={options.connected || Boolean(config())}
      fallback={<SettingsEmpty message={t("pluginsPage.connectToManage")} carapace />}
    >
      <Show
        when={config()}
        fallback={
          !options.configError && !options.configSchemaLoading && options.configValue ? (
            <SettingsEmpty message={t("pluginsPage.schemaUnavailable")} carapace />
          ) : null
        }
      >
        {(current) => (
          <>
            <ConfigNode
              params={{
                rawAvailable: false,
                maskSensitive: true,
                schema: current().schema,
                value: current().value.plugins ?? {},
                path: ["plugins"],
                hints: options.configHints,
                unsupported: new Set(options.configUnsupportedPaths),
                disabled: !options.canEditConfig || options.configBusy,
                showLabel: false,
                onPatch: options.onConfigPatch,
                onRemove: options.onConfigRemove,
              }}
            />
          </>
        )}
      </Show>
      <PluginSettingsReadStatus
        model={{ ...options, configSchema: options.advancedSchema }}
        loading={
          !options.configError && !config() && (options.configSchemaLoading || !options.configValue)
        }
        rows={4}
        renderError={(error, onRetry) => <PluginRetryError error={error} onRetry={onRetry} />}
      />
    </Show>
  );
}
export function AdvancedSettings(props: InventoryProps): JSX.Element {
  return (
    <div id="plugin-settings-advanced" class="settings-stack">
      <PluginManager />
      <SettingsSection
        title={t("pluginsPage.advanced")}
        description={t("pluginsPage.advancedDescription")}
        actions={
          <button
            type="button"
            class="btn btn--xs btn--icon oc-action oc-action-icon oc-action-secondary"
            aria-label={t("common.reload")}
            disabled={props.configBusy || props.configSchemaLoading}
            onClick={() => props.onConfigReload()}
          >
            <Icon name="refresh" />
          </button>
        }
        carapace
      >
        <AdvancedSettingsFields {...props} />
      </SettingsSection>
    </div>
  );
}
