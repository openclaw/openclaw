import { createMemo, For, Show } from "solid-js";
import {
  analyzeConfigSchema,
  renderConfigTierGroups,
  renderNode,
  schemaType,
  type JsonSchema,
} from "../../components/config-form.ts";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { formatChannelExtraValue, resolveChannelConfigValue } from "../../lib/channels/index.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import type { ChannelsProps } from "./view.types.ts";

function resolveSchemaNode(schema: JsonSchema | null, path: string[]): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current || schemaType(current) !== "object") {
      return null;
    }
    const additional = current.additionalProperties;
    current =
      current.properties?.[key] ||
      (additional && typeof additional === "object" ? additional : null);
  }
  return current;
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

export function ChannelConfig(params: { channelId: string; props: ChannelsProps }) {
  const locale = projectI18n(i18n);
  const analysis = createMemo(() => analyzeConfigSchema(params.props.config.configSchema));
  const node = createMemo(() =>
    resolveSchemaNode(analysis().schema, ["channels", params.channelId]),
  );
  const value = createMemo(
    () => resolveChannelConfigValue(params.props.config.configForm ?? {}, params.channelId) ?? {},
  );
  const extraFields = createMemo(() => EXTRA_CHANNEL_FIELDS.filter((field) => field in value()));
  const unsupported = createMemo(() => new Set(analysis().unsupportedPaths));
  const disabled = createMemo(
    () => params.props.config.configSaving || params.props.config.configSchemaLoading,
  );
  const form = createMemo(() => {
    locale.revision();
    const schema = node();
    if (!schema) {
      return undefined;
    }
    return renderConfigTierGroups({
      schema,
      path: ["channels", params.channelId],
      hints: params.props.config.configUiHints,
      revealAdvanced: params.props.showAdvancedSettings,
      onShowAdvanced: () => params.props.onShowAdvancedSettings(true),
      onHideAdvanced: () => params.props.onShowAdvancedSettings(false),
      renderTier: (tier) =>
        renderNode({
          schema: tier,
          value: value(),
          path: ["channels", params.channelId],
          hints: params.props.config.configUiHints,
          unsupported: unsupported(),
          disabled: disabled(),
          showLabel: false,
          maskSensitive: true,
          onPatch: params.props.onConfigPatch,
        }),
    });
  });
  return (
    <Show
      when={!params.props.config.configSchemaLoading}
      fallback={<SettingsLoadingSkeleton label={t("channels.config.loadingSchema")} rows={2} />}
    >
      <div class="settings-row settings-row--stacked">
        <Show
          when={node()}
          fallback={
            <div class="settings-row__desc">
              {t(
                analysis().schema
                  ? "channels.config.channelSchemaUnavailable"
                  : "channels.config.schemaUnavailable",
              )}
            </div>
          }
        >
          <div class="config-form">
            <LitContent render={() => form()} />
          </div>
          <Show when={extraFields().length > 0}>
            <div>
              <For each={extraFields()}>
                {(field) => (
                  <div class="settings-row__desc">
                    {field}: {formatChannelExtraValue(value()[field])}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
        {params.props.config.lastError ? (
          <div class="callout danger" role="alert">
            {params.props.config.lastError}
          </div>
        ) : undefined}
        <div class="settings-row__control">
          <button
            class="btn primary"
            disabled={disabled() || !params.props.config.configFormDirty}
            onClick={() => params.props.onConfigSave()}
          >
            {params.props.config.configSaving ? t("common.saving") : t("common.save")}
          </button>
          <button class="btn" disabled={disabled()} onClick={() => params.props.onConfigReload()}>
            {t("common.reload")}
          </button>
        </div>
      </div>
    </Show>
  );
}
