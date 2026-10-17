import { Picker } from "../../components/select-picker.ts";
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
  return (
    <Picker
      params={{
        label: t("quickSettings.language"),
        value: props.localeOverride ?? "system",
        options: [
          {
            value: "system",
            label: `${t("common.system")} (${languageLabel(props.systemLocale)})`,
          },
          ...SUPPORTED_LOCALES.map((value) => ({ value, label: languageLabel(value) })),
        ],
        showOptionTooltips: false,
        onChange: (value) =>
          props.onLocaleChange(SUPPORTED_LOCALES.find((locale) => locale === value)),
      }}
    />
  );
}
