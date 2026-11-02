import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Errored, For, Loading } from "solid-js";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { pluginConfigSchema, pluginEntryValue } from "../plugins/settings-model.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { sessionSourcePresentations } from "./session-source-presentation.ts";
import { ConfigReadError, ConfigReadStatus } from "./view-readiness.tsx";
import { asConfigSchema } from "./view-schema.tsx";
import type { ConfigProps } from "./view-types.ts";

export function SessionSources(
  props: ConfigProps & { sectionRef?: (element: HTMLElement) => void },
) {
  const scope = createMemo(() => props.sessionSourcePlugins?.scope);
  const schemaRead = createMemo(() => props.schemaRead ?? undefined);
  const schemaStatus = () => {
    if (props.schema) {
      return null;
    }
    const result = schemaRead();
    if (result?.ok === false) {
      throw new Error(result.error);
    }
    return <p class="settings-section__desc">{t("common.loading")}</p>;
  };
  const installed = () => props.sessionSourcePlugins?.read();
  const sources = () => {
    const schema = asConfigSchema(props.schema);
    return sessionSourcePresentations
      .filter((source) => installed()?.has(source.pluginId))
      .map((source) =>
        Object.assign({}, source, {
          enabledSchema: pluginConfigSchema(schema, source.pluginId)?.properties?.[source.key]
            ?.properties?.enabled,
        }),
      );
  };
  const disabled = () =>
    !props.connected ||
    !props.configLoaded ||
    !props.formValue ||
    props.mutationAllowed === false ||
    props.loading ||
    props.schemaLoading ||
    props.saving ||
    props.applying ||
    props.updating ||
    props.rawDraftPending === true;
  return (
    <section
      ref={(element) => props.sectionRef?.(element)}
      id={APPEARANCE_SETTINGS_TARGET_IDS.sessionSources}
      class="settings-section"
      onFocusIn={() => props.onAppearanceDataNeeded?.()}
    >
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("configView.sessionSources.title")}</h2>
        {props.pluginsHref ? (
          <a class="btn btn--sm" href={props.pluginsHref}>
            {t("configView.sessionSources.managePlugins")}
          </a>
        ) : null}
      </div>
      <p class="settings-section__desc">{t("configView.sessionSources.hint")}</p>
      <ConfigReadStatus config={props} />
      {props.configLoaded ? (
        <Errored
          fallback={(error, reset) => (
            <ConfigReadError
              message={formatUiError(error())}
              onRetry={() => {
                props.onRetrySchema?.();
                reset();
              }}
            />
          )}
        >
          <Loading fallback={<p class="settings-section__desc">{t("common.loading")}</p>}>
            {schemaStatus()}
          </Loading>
        </Errored>
      ) : null}
      <Errored
        fallback={(_error) => (
          <p class="settings-section__desc">{t("configView.sessionSources.unavailable")}</p>
        )}
      >
        <Loading
          on={scope()}
          fallback={<p class="settings-section__desc">{t("common.loading")}</p>}
        >
          {sources().length ? (
            <div class="settings-group">
              <For each={sources()} keyed={(source) => source.pluginId}>
                {(source) => {
                  const preference = () =>
                    asNullableRecord(
                      asNullableRecord(
                        pluginEntryValue(props.formValue, source().pluginId).config,
                      )?.[source().key],
                    )?.enabled;
                  return (
                    <SettingsToggleRow
                      icon={
                        <ProviderBrandIcon provider={source().icon} class="session-source__icon" />
                      }
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
                          [
                            "plugins",
                            "entries",
                            source().pluginId,
                            "config",
                            source().key,
                            "enabled",
                          ],
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
                installed()
                  ? "configView.sessionSources.empty"
                  : !props.configLoaded || !props.schema
                    ? "common.loading"
                    : "configView.sessionSources.unavailable",
              )}
            </p>
          )}
        </Loading>
      </Errored>
      <p class="settings-section__desc">{t("configView.sessionSources.scope")}</p>
    </section>
  );
}
