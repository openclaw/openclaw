import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { For, createMemo } from "solid-js";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { pluginConfigSchema, pluginEntryValue } from "../plugins/settings-model.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { asConfigSchema } from "./view-schema.tsx";
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

export function SessionSources(props: ConfigProps) {
  const sources = createMemo(() => {
    const schema = asConfigSchema(props.schema);
    return SESSION_SOURCES.filter((source) =>
      props.installedSessionSourcePluginIds?.has(source.pluginId),
    ).map((source) =>
      Object.assign({}, source, {
        enabledSchema: pluginConfigSchema(schema, source.pluginId)?.properties?.[source.key]
          ?.properties?.enabled,
      }),
    );
  });
  const disabled = () =>
    !props.connected ||
    props.mutationAllowed === false ||
    props.loading ||
    props.schemaLoading ||
    props.saving ||
    props.applying ||
    props.updating ||
    props.rawDraftPending === true;
  return (
    <section id={APPEARANCE_SETTINGS_TARGET_IDS.sessionSources} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("configView.sessionSources.title")}</h2>
        {props.pluginsHref ? (
          <a class="btn btn--sm" href={props.pluginsHref}>
            {t("configView.sessionSources.managePlugins")}
          </a>
        ) : null}
      </div>
      <p class="settings-section__desc">{t("configView.sessionSources.hint")}</p>
      {sources().length ? (
        <div class="settings-group">
          <For each={sources()} keyed={(source) => source.pluginId}>
            {(source) => {
              const preference = () =>
                asNullableRecord(
                  asNullableRecord(pluginEntryValue(props.formValue, source().pluginId).config)?.[
                    source().key
                  ],
                )?.enabled;
              return (
                <SettingsToggleRow
                  icon={<ProviderBrandIcon provider={source().icon} class="session-source__icon" />}
                  title={t(source().labelKey)}
                  description={
                    source().enabledSchema
                      ? t("configView.sessionSources.sourceHint", { plugin: source().plugin })
                      : t(
                          props.schemaLoading
                            ? "common.loading"
                            : "configView.sessionSources.unavailable",
                        )
                  }
                  checked={
                    typeof preference() === "boolean"
                      ? preference() === true
                      : source().enabledSchema?.default === true
                  }
                  disabled={disabled() || !source().enabledSchema}
                  onChange={(enabled) =>
                    props.onFormPatch(
                      ["plugins", "entries", source().pluginId, "config", source().key, "enabled"],
                      enabled,
                    )
                  }
                />
              );
            }}
          </For>
        </div>
      ) : (
        <p class="settings-section__desc">
          {t(
            props.sessionSourcePluginsLoading
              ? "common.loading"
              : props.installedSessionSourcePluginIds
                ? "configView.sessionSources.empty"
                : "configView.sessionSources.unavailable",
          )}
        </p>
      )}
      <p class="settings-section__desc">{t("configView.sessionSources.scope")}</p>
    </section>
  );
}
