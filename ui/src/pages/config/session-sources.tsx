import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import {
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import { pluginConfigSchema, pluginEntryValue } from "../plugins/settings-model.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { sessionSourcePresentations } from "./session-source-presentation.ts";
import {
  ConfigReadBoundary,
  ConfigReadError,
  ConfigReadFailure,
  isConfigReadDenied,
} from "./view-readiness.tsx";
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
      throw new ConfigReadFailure(result.error, result.denied);
    }
    return props.schemaLoading ? <SettingsLoadingSkeleton rows={2} /> : null;
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
        {props.pluginsHref && props.configReadAccess !== "denied" ? (
          <a class="btn btn--sm" href={props.pluginsHref}>
            {t("configView.sessionSources.managePlugins")}
          </a>
        ) : null}
      </div>
      <Show when={props.appearanceDataRequested !== false || props.configReadAccess === "denied"}>
        <ConfigReadBoundary
          config={props}
          displayReady={
            props.configReadAccess !== "denied" && (props.configLoaded || props.loading)
          }
          fallback={<SettingsLoadingSkeleton rows={2} />}
        >
          <Errored
            fallback={(_error) => (
              <p class="settings-section__desc">{t("configView.sessionSources.unavailable")}</p>
            )}
          >
            <Loading on={scope()} fallback={<SettingsLoadingSkeleton rows={2} />}>
              <Errored
                fallback={(error, reset) => (
                  <ConfigReadError
                    message={formatUiError(error())}
                    onRetry={
                      isConfigReadDenied(error())
                        ? undefined
                        : () => {
                            props.onRetrySchema?.();
                            reset();
                          }
                    }
                  />
                )}
              >
                {props.configLoaded ? schemaStatus() : null}
              </Errored>
              {sources().length ? (
                <>
                  <p class="settings-section__desc">{t("configView.sessionSources.hint")}</p>
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
                          <Show
                            when={
                              !props.configLoaded ||
                              props.schemaLoading ||
                              typeof preference() === "boolean" ||
                              source().enabledSchema
                            }
                            fallback={
                              <SettingsRow
                                title={t(source().labelKey)}
                                description={t("configView.sessionSources.unavailable")}
                              />
                            }
                          >
                            <SettingsToggleRow
                              icon={
                                <ModelProviderIcon
                                  provider={source().icon}
                                  class="session-source__icon"
                                />
                              }
                              title={t(source().labelKey)}
                              description={
                                source().enabledSchema
                                  ? t("configView.sessionSources.sourceHint", {
                                      plugin: source().plugin,
                                    })
                                  : t(
                                      props.schemaLoading
                                        ? "common.loading"
                                        : "configView.sessionSources.unavailable",
                                    )
                              }
                              pending={
                                !props.configLoaded ||
                                (typeof preference() !== "boolean" && !source().enabledSchema)
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
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                  <p class="settings-section__desc settings-section__scope">
                    {t("configView.sessionSources.scope")}
                  </p>
                </>
              ) : (
                <p class="settings-section__desc">
                  {t(
                    installed()
                      ? "configView.sessionSources.empty"
                      : "configView.sessionSources.unavailable",
                  )}
                </p>
              )}
            </Loading>
          </Errored>
        </ConfigReadBoundary>
      </Show>
    </section>
  );
}
