import { html } from "lit";
import {
  analyzeConfigSchema,
  renderConfigTierGroups,
  renderNode,
  schemaType,
  type JsonSchema,
} from "../../components/config-form.ts";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatChannelExtraValue, resolveChannelConfigValue } from "../../lib/channels/index.ts";
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

function renderExtraChannelFields(value: Record<string, unknown>) {
  const fields = EXTRA_CHANNEL_FIELDS.filter((field) => field in value);
  if (fields.length === 0) {
    return null;
  }
  return html`
    <div>
      ${fields.map(
        (field) => html`
          <div class="settings-row__desc">${field}: ${formatChannelExtraValue(value[field])}</div>
        `,
      )}
    </div>
  `;
}

function renderChannelConfigForm(channelId: string, props: ChannelsProps, disabled: boolean) {
  const config = props.config;
  const analysis = analyzeConfigSchema(config.configSchema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html`<div class="settings-row__desc">${t("channels.config.schemaUnavailable")}</div>`;
  }
  const node = resolveSchemaNode(normalized, ["channels", channelId]);
  if (!node) {
    return html`
      <div class="settings-row__desc">${t("channels.config.channelSchemaUnavailable")}</div>
    `;
  }
  const value = resolveChannelConfigValue(config.configForm ?? {}, channelId) ?? {};
  const path = ["channels", channelId];
  const unsupported = new Set(analysis.unsupportedPaths);
  return html`
    <div class="config-form">
      ${renderConfigTierGroups({
        schema: node,
        path,
        hints: config.configUiHints,
        revealAdvanced: props.showAdvancedSettings,
        onShowAdvanced: () => props.onShowAdvancedSettings(true),
        onHideAdvanced: () => props.onShowAdvancedSettings(false),
        renderTier: (tier) =>
          renderNode({
            schema: tier,
            value,
            path,
            hints: config.configUiHints,
            unsupported,
            disabled,
            showLabel: false,
            onPatch: props.onConfigPatch,
          }),
      })}
    </div>
    ${renderExtraChannelFields(value)}
  `;
}

export function renderChannelConfigSection(params: { channelId: string; props: ChannelsProps }) {
  const { channelId, props } = params;
  const disabled = props.config.configSaving || props.config.configSchemaLoading;
  if (props.config.configSchemaLoading) {
    return renderSettingsLoadingSkeleton({ label: t("channels.config.loadingSchema"), rows: 2 });
  }
  return html`
    <div class="settings-row settings-row--stacked">
      ${renderChannelConfigForm(channelId, props, disabled)}
      ${
        props.config.lastError
          ? html`<div class="callout danger" role="alert">${props.config.lastError}</div>`
          : null
      }
      <div class="settings-row__control">
        <button
          class="btn primary"
          ?disabled=${disabled || !props.config.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.config.configSaving ? t("common.saving") : t("common.save")}
        </button>
        <button class="btn" ?disabled=${disabled} @click=${() => props.onConfigReload()}>
          ${t("common.reload")}
        </button>
      </div>
    </div>
  `;
}
