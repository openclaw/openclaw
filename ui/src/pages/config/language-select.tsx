import { For } from "solid-js";
import "../../components/web-awesome-select.ts";
import "../../styles/select-picker.css";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/index.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function languageLabel(locale: Locale) {
  const key = locale.replace(/-([a-zA-Z])/g, (_, character) => character.toUpperCase());
  return t(`languages.${key}`);
}

export function LanguageSelect(props: {
  localeOverride: Locale | undefined;
  systemLocale: Locale;
  onLocaleChange: (locale: Locale | undefined) => void;
}) {
  const value = () => props.localeOverride ?? "system";
  const systemLabel = () => `${t("common.system")} (${languageLabel(props.systemLocale)})`;
  return (
    <wa-select
      class="settings-select"
      prop:value={value()}
      onChange={(event: Event) => {
        // SAFETY: This change handler is bound directly to the value-bearing wa-select.
        const next = (event.currentTarget as HTMLElement & { value: string }).value;
        // SAFETY: The options below are "system" or members of SUPPORTED_LOCALES.
        props.onLocaleChange(next === "system" ? undefined : (next as Locale));
      }}
    >
      <span slot="label" class="settings-control__sr-label">
        {t("quickSettings.language")}
      </span>
      <wa-option value="system" prop:label={systemLabel()} prop:selected={value() === "system"}>
        {systemLabel()}
      </wa-option>
      <For each={SUPPORTED_LOCALES}>
        {(option) => (
          <wa-option
            value={option}
            prop:label={languageLabel(option)}
            prop:selected={value() === option}
          >
            {languageLabel(option)}
          </wa-option>
        )}
      </For>
    </wa-select>
  );
}
