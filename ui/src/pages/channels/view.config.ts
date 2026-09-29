// Control UI view renders channels screen content.
import { html } from "lit";
import type { ConfigUiHints } from "../../api/types.ts";
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

type ChannelConfigFormProps = {
  channelId: string;
  configValue: Record<string, unknown> | null;
  schema: unknown;
  uiHints: ConfigUiHints;
  disabled: boolean;
  showAdvanced: boolean;
  onShowAdvanced: (enabled: boolean) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

function resolveSchemaNode(schema: JsonSchema | null, path: string[]): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current) {
      return null;
    }
    const type = schemaType(current);
    if (type === "object") {
      const properties = current.properties ?? {};
      if (properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (additional && typeof additional === "object") {
        current = additional;
        continue;
      }
      return null;
    }
    return null;
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

function renderChannelConfigForm(props: ChannelConfigFormProps) {
  const analysis = analyzeConfigSchema(props.schema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html`<div class="settings-row__desc">${t("channels.config.schemaUnavailable")}</div>`;
  }
  const node = resolveSchemaNode(normalized, ["channels", props.channelId]);
  if (!node) {
    return html`
      <div class="settings-row__desc">${t("channels.config.channelSchemaUnavailable")}</div>
    `;
  }
  const configValue = props.configValue ?? {};
  const value = resolveChannelConfigValue(configValue, props.channelId) ?? {};
  const path = ["channels", props.channelId];
  const unsupported = new Set(analysis.unsupportedPaths);
  return html`
    <div class="config-form">
      ${renderConfigTierGroups({
        schema: node,
        path,
        hints: props.uiHints,
        revealAdvanced: props.showAdvanced,
        onShowAdvanced: () => props.onShowAdvanced(true),
        onHideAdvanced: () => props.onShowAdvanced(false),
        renderTier: (tier) =>
          renderNode({
            schema: tier,
            value,
            path,
            hints: props.uiHints,
            unsupported,
            disabled: props.disabled,
            showLabel: false,
            onPatch: props.onPatch,
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
      ${renderChannelConfigForm({
        channelId,
        configValue: props.config.configForm,
        schema: props.config.configSchema,
        uiHints: props.config.configUiHints,
        disabled,
        showAdvanced: props.showAdvancedSettings,
        onShowAdvanced: props.onShowAdvancedSettings,
        onPatch: props.onConfigPatch,
      })}
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
