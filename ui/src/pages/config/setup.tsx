import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show } from "solid-js";
import { ConfigNode } from "../../components/config-form.node.tsx";
import {
  humanize,
  localizedHintForPath,
  type JsonSchema,
} from "../../components/config-form.shared.ts";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SETUP_CONSENT_DEFAULTS, SETUP_HISTORY_KEYS } from "./setup-schema.ts";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

export function SetupSection(props: {
  schema: JsonSchema;
  config: ConfigProps;
  disabled: boolean;
}) {
  const wizard = () => {
    const value = props.config.formValue?.wizard;
    return isRecord(value) ? value : {};
  };
  return (
    <SettingsPage>
      <details
        class="settings-section config-advanced-disclosure"
        id="config-section-wizard"
        open={props.config.forceAdvancedSection === "wizard"}
      >
        <summary class="settings-section__heading config-advanced-disclosure__summary">
          {t("configForm.sections.wizard.label")}
        </summary>
        <p class="settings-section__desc">{t("configForm.sections.wizard.description")}</p>
        <SettingsGroup>
          <For each={Object.entries(SETUP_CONSENT_DEFAULTS)} keyed={(entry) => entry[0]}>
            {(entry) => (
              <Show when={props.schema.properties?.[entry()[0]]}>
                {(field) => (
                  <ConfigNode
                    params={{
                      schema: { ...field(), default: entry()[1] },
                      value: wizard()[entry()[0]],
                      path: ["wizard", entry()[0]],
                      hints: props.config.uiHints,
                      unsupported: new Set(),
                      disabled: props.disabled,
                      onPatch: props.config.onFormPatch,
                      onRemove: props.config.onFormRemove,
                    }}
                  />
                )}
              </Show>
            )}
          </For>
        </SettingsGroup>
        <SettingsGroup>
          <For each={SETUP_HISTORY_KEYS} keyed={(key) => key}>
            {(key) => (
              <Show when={typeof wizard()[key()] === "string" && wizard()[key()]}>
                <SettingsRow
                  title={
                    localizedHintForPath(["wizard", key()], props.config.uiHints)?.label ??
                    props.schema.properties?.[key()]?.title ??
                    humanize(key())
                  }
                  description={String(wizard()[key()])}
                />
              </Show>
            )}
          </For>
        </SettingsGroup>
      </details>
    </SettingsPage>
  );
}

export function renderSetupSection(schema: JsonSchema, props: ConfigProps, disabled: boolean) {
  return <SetupSection schema={schema} config={props} disabled={disabled} />;
}
