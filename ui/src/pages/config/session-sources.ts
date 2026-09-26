import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { pluginConfigSchema, pluginEntryValue } from "../plugins/settings-model.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { asConfigSchema } from "./view-schema.ts";
import type { ConfigProps } from "./view-types.ts";

const SESSION_SOURCES = [
  {
    pluginId: "anthropic",
    plugin: "Anthropic",
    icon: "claude",
    key: "sessionCatalog",
    labelKey: "configView.sessionSources.claude",
  },
  {
    pluginId: "codex",
    plugin: "Codex",
    icon: "codex",
    key: "sessionCatalog",
    labelKey: "configView.sessionSources.codex",
  },
  {
    pluginId: "opencode",
    plugin: "OpenCode",
    icon: "opencode",
    key: "sessionCatalog",
    labelKey: "configView.sessionSources.opencode",
  },
  {
    pluginId: "acpx",
    plugin: "ACPX",
    icon: "pi",
    key: "piSessionCatalog",
    labelKey: "configView.sessionSources.pi",
  },
] as const;

export function renderSessionSources(props: ConfigProps) {
  const schema = asConfigSchema(props.schema);
  const sources = SESSION_SOURCES.filter((source) =>
    props.installedSessionSourcePluginIds?.has(source.pluginId),
  ).map((source) => {
    const enabledSchema = pluginConfigSchema(schema, source.pluginId)?.properties?.[source.key]
      ?.properties?.enabled;
    return Object.assign({}, source, { enabledSchema });
  });
  const disabled =
    !props.connected ||
    props.mutationAllowed === false ||
    props.loading ||
    props.schemaLoading ||
    props.saving ||
    props.applying ||
    props.updating ||
    props.rawDraftPending === true;
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.sessionSources} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.sessionSources.title")}</h2>
        ${
          props.pluginsHref
            ? html`<a class="btn btn--sm" href=${props.pluginsHref}
                >${t("configView.sessionSources.managePlugins")}</a
              >`
            : nothing
        }
      </div>
      <p class="settings-section__desc">${t("configView.sessionSources.hint")}</p>
      ${
        sources.length > 0
          ? html`<div class="settings-group">
              ${sources.map(({ pluginId, plugin, icon, key, labelKey, enabledSchema }) => {
                const config = asNullableRecord(pluginEntryValue(props.formValue, pluginId).config);
                const preference = asNullableRecord(config?.[key])?.enabled;
                return renderSettingsToggleRow({
                  icon: renderProviderBrandIcon(icon, { className: "session-source__icon" }),
                  title: t(labelKey),
                  description: enabledSchema
                    ? t("configView.sessionSources.sourceHint", { plugin })
                    : t(
                        props.schemaLoading
                          ? "common.loading"
                          : "configView.sessionSources.unavailable",
                      ),
                  checked:
                    typeof preference === "boolean" ? preference : enabledSchema?.default === true,
                  disabled: disabled || !enabledSchema,
                  onChange: (enabled) =>
                    props.onFormPatch(
                      ["plugins", "entries", pluginId, "config", key, "enabled"],
                      enabled,
                    ),
                });
              })}
            </div>`
          : html`<p class="settings-section__desc">
              ${t(
                props.sessionSourcePluginsLoading
                  ? "common.loading"
                  : props.installedSessionSourcePluginIds
                    ? "configView.sessionSources.empty"
                    : "configView.sessionSources.unavailable",
              )}
            </p>`
      }
      <p class="settings-section__desc">${t("configView.sessionSources.scope")}</p>
    </section>
  `;
}
