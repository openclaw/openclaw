import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import { analyzeConfigSchema } from "../../components/config-form.analyze.ts";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsSection, SettingsUnavailable } from "../../components/solid/settings-ui.tsx";
import { configSecretFields } from "../../lib/config/config-secret-fields.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginManager } from "../../plugins/control-ui-manager.solid.tsx";
import { pluginAdvancedSchema } from "./settings-model.ts";
import { PluginSettingsReadStatus } from "./settings-read-status.tsx";
import { PluginRetryError } from "./settings-retry-error.tsx";
import type { InventoryProps } from "./settings-view.tsx";

function AdvancedSettingsFields(options: InventoryProps): JSX.Element {
  const rawConfigSchema = createMemo(() => options.rawConfigSchema);
  const analysis = createMemo(() => analyzeConfigSchema(rawConfigSchema()));
  const schema = createMemo(() => pluginAdvancedSchema(analysis().schema));
  const config = createMemo(() => {
    const currentSchema = schema();
    const value = options.configValue;
    return currentSchema && value ? { schema: currentSchema, value } : null;
  });
  return (
    <Show
      when={options.connected || Boolean(config())}
      fallback={<SettingsUnavailable message={t("pluginsPage.connectToManage")} />}
    >
      <Show
        when={config()}
        fallback={
          !options.configError && !options.configSchemaLoading && options.configValue ? (
            <SettingsUnavailable message={t("pluginsPage.schemaUnavailable")} />
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
                unsupported: new Set(analysis().unsupportedPaths),
                disabled: !options.canEditConfig || options.configBusy,
                showLabel: false,
                secretFields: configSecretFields(options.settingsContext),
                onPatch: options.onConfigPatch,
                onRemove: options.onConfigRemove,
              }}
            />
          </>
        )}
      </Show>
      <PluginSettingsReadStatus
        model={{ ...options, configSchema: schema() }}
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
          <RefreshButton
            label={t("common.reload")}
            busy={props.configBusy || props.configSchemaLoading}
            onClick={() => props.onConfigReload()}
          />
        }
        carapace
      >
        <AdvancedSettingsFields {...props} />
      </SettingsSection>
    </div>
  );
}
